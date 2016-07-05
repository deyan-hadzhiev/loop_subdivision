'use-strict';

// monkey-patch dat.GUI

dat.GUI.prototype.removeFolder = function (fldl) {
	var name = fldl.name;
	var folder = this.__folders[name];
	if (!folder) {
		return;
	}
	folder.close();
	this.__ul.removeChild(folder.domElement.parentNode);
	delete this.__folders[name];
	this.onResize();
}

// global variables

var container, stats

var camera, controls, scene, renderer;
var gui;
var startTime = Date.now();

// some constants
const epsilon = 1e-6;
const subdivMax = 6;
const uint16Max = 65535;

var params = {
	geometry: 'tetrahedron',
	material: 'phongFlat',
	meshColor: '#0080ff',
	wireframe: false,
	subdivAmount: 0,
};

var paramControllers = {
	subdivAmount: null,
}

var predefinedGeometriesNames = [
	'tetrahedron',
	'cube',
	'sphere',
	'icosahedron',
	'dodecahedron',
	// some more irregular shapes too
	'plane',
	'cone',
	'ring',
	'torus',
	'torusKnot',
];

var predefinedGeometries = [];

var currentParams = {
	subdivAmount: -1,
	originalGeometry: null,
	mesh: null,
	meshColor: new THREE.Color(parseInt(params.meshColor.replace('#', '0x'))),
	phongMatFlat: null,
	phongMatSmooth: null,
	lambertMat: null,
	normalMat: new THREE.MeshNormalMaterial(),
	depthMat: new THREE.MeshDepthMaterial(),
};

// Subdivision

var EMFace = function() {
	this.e = new Uint32Array(3);
}

var EMVertex = function() {
	this.e = [];
}

var EMEdge = function() {
	this.v = new Uint32Array(2);
	this.f = new Uint32Array(2);
	this.ov = new Uint32Array(2); //!< holds the opposite vertices for each of the faces
	this.getOpposite = function(vi) {
		return (this.v[0] == vi ? this.v[1] : this.v[0]);
	}
}

var EdgeMesh = function() {
	this.faces = [];
	this.vertices = [];
	this.edges = [];

	// v0 - index of the first vertex
	// v1 - index of the second vertex
	// fi - index of the face
	// ei - index of the edge in the face
	// ov - opposite vertex of the edge for the current face
	this.processEdge = function(v0, v1, fi, ei, ov) {
		const minV = Math.min(v0, v1);
		const maxV = Math.max(v0, v1);
		var edgeIndex = -1;
		// try to find existing edge
		for (var i = 0, il = this.edges.length; i < il; ++i) {
			if (this.edges[i].v[0] == minV && this.edges[i].v[1] == maxV) {
				edgeIndex = i;
				break;
			}
		}
		// now if there was no index found this is a new edge
		if (-1 == edgeIndex) {
			var edge = new EMEdge;
			edge.v[0] = minV;
			edge.v[1] = maxV;
			edge.f[0] = fi;
			edge.ov[0] = ov;
			edge.f[1] = uint16Max; // invalid value for connectivity checks later
			edge.ov[1] = ov; // it will possibly be overwritten later, but should be the same as ov for correctness
			edgeIndex = this.edges.length;
			this.edges.push(edge);
			// add the edge to the vertices
			this.vertices[minV].e.push(edgeIndex);
			this.vertices[maxV].e.push(edgeIndex);
		} else {
			// just add the second face to the edge
			this.edges[edgeIndex].f[1] = fi;
			this.edges[edgeIndex].ov[1] = ov;
		}
		// now update the edge index in the faces array
		this.faces[fi].e[ei] = edgeIndex;
	}

	this.generate = function(vertices, indices) {
		// create all the vertices (each 3 elements are a single vertex, because this is float array)
		for (var vi = 0, vil = vertices.length; vi < vil; vi += 3) {
			this.vertices.push(new EMVertex);
		}
		// iterate over the indices, each 3 form a triangle
		for (var fi = 0, fil = indices.length; fi < fil; fi += 3) {
			this.faces.push(new EMFace);
			// iterate over the exact verices and check for edges
			const faceArrayIndex = fi / 3;
			// process the edges
			this.processEdge(indices[fi    ], indices[fi + 1], faceArrayIndex, 0, indices[fi + 2]);
			this.processEdge(indices[fi + 1], indices[fi + 2], faceArrayIndex, 1, indices[fi    ]);
			this.processEdge(indices[fi + 2], indices[fi    ], faceArrayIndex, 2, indices[fi + 1]);
		}
	}
}

var BetaValencyCache = function(maxValency) {
	this.cache = new Float32Array(maxValency + 1);
	this.cache[0] = 0.0;
	this.cache[1] = 0.0;
	this.cache[2] = 1.0 / 8.0;
	this.cache[3] = 3.0 / 16.0;
	for (var i = 4; i < maxValency + 1; ++i) {
		this.cache[i] = (1.0 / i) * (5.0 / 8.0 - Math.pow( 3.0 / 8.0 + (1.0 / 4.0) * Math.cos( 2.0 * Math.PI / i ), 2.0));
		// Warren's modified formula:
		// this.cache[i] = 3.0 / (8.0 * i);
	}
}

var subdivider = null;

var Subdivision = function(geometry) {
	if (geometry instanceof THREE.Geometry) {
		this.initialGeometry = new THREE.BufferGeometry();
		var vertices = new Float32Array(geometry.vertices.length * 3);
		for (var i = 0, il = geometry.vertices.length; i < il; ++i) {
			vertices[i * 3 + 0] = geometry.vertices[i].x;
			vertices[i * 3 + 1] = geometry.vertices[i].y;
			vertices[i * 3 + 2] = geometry.vertices[i].z;
		}
		var indices = new Uint16Array(geometry.faces.length * 3);
		for (var i = 0, il = geometry.faces.length; i < il; ++i) {
			indices[i * 3 + 0] = geometry.faces[i].a;
			indices[i * 3 + 1] = geometry.faces[i].b;
			indices[i * 3 + 2] = geometry.faces[i].c;
		}
		this.initialGeometry.addAttribute('position', new THREE.BufferAttribute(vertices, 3));
		this.initialGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
		this.initialGeometry.computeVertexNormals();
	} else {
		this.initialGeometry = new THREE.BufferGeometry().copy(geometry);
	}
	this.initialGeometry.computeBoundingSphere();
	this.cachedSubdivisions = [];

	// functions
	this.dispose = function dispose() {
		this.initialGeometry.dispose();
		for (var i = 0, il = this.cachedSubdivisions.length; i < il; ++i) {
			this.cachedSubdivisions[i].dispose();
		}
	}

	this.subdivide = function subdivide(num) {
		if (num == 0) {
			return this.initialGeometry;
		} else if (this.cachedSubdivisions[num - 1]) {
			return this.cachedSubdivisions[num - 1];
		} else {
			var previousSubdiv = this.subdivide(num - 1);
			var subdivided = this.subdivideGeometry(previousSubdiv);
			this.cachedSubdivisions[num - 1] = subdivided;
			return subdivided;
		}
	}

	this.subdivideGeometry = function subdivideGeometry(buffGeom) {
		var retval = new THREE.BufferGeometry();
		var oldVertexBuffer = buffGeom.getAttribute('position').array;
		var oldIndexBuffer = buffGeom.getIndex().array;
		var edgeMesh = new EdgeMesh;
		edgeMesh.generate(oldVertexBuffer, oldIndexBuffer);
		const oldVertCount = edgeMesh.vertices.length;
		const oldEdgeCount = edgeMesh.edges.length;
		const oldFaceCount = edgeMesh.faces.length;
		// now compute the new number of vertices using data from the edge mesh and the Euler formula
		// we know that for a given mesh we can calculate the Euler characteristic using his formula:
		//  Chi = V - E + F
		// The subdivision does not change the Euler characteristic of the mesh, thus we may use it
		// to calculate the new number of vertices, noting that the subdivision will increase the
		// number of faces exactly 4 times and the number of edges is calculated based on existing
		// faces and edges - each subdivided faces generates 3 new edges and each subdivided edge
		// generates 2 new edges
		//
		//  o---o---o
		//   \ / \ /
		//    o---o
		//     \ /
		//      o
		//
		const Chi = oldVertCount - oldEdgeCount + oldFaceCount;
		const newEdgeCount = oldEdgeCount * 2 + oldFaceCount * 3;
		const newFaceCount = oldFaceCount * 4;
		// So moving the variables around we get:
		//  V = E - F + Chi;
		const newVertCount = newEdgeCount - newFaceCount + Chi;

		// compute appropriate beta valency cache for extraordinary points (with valency not exactly 6)
		var maxValency = -1;
		for (var vi = 0; vi < oldVertCount; ++vi) {
			maxValency = Math.max(maxValency, edgeMesh.vertices[vi].e.length);
		}
		if (2 >= maxValency) {
			throw Error('This is no mesh at all');
		}
		var betaValCache = new BetaValencyCache(maxValency);

		// allocate new vertices array
		var newVertexBuffer = new Float32Array(newVertCount * 3);

		// start the actual subdivision

		//  Step 1 - calculate new vetices from old verices
		for (var i = 0; i < oldVertCount; ++i) {
			// save the valency of the vertex, we'll reuse it
			const vertexValency = edgeMesh.vertices[i].e.length;
			// get the appropriate beta value for the vertex
			const beta = betaValCache.cache[vertexValency];
			const vertexWeightBeta = 1.0 - vertexValency * beta;

			// use the values directly
			// first add the original x, y and z with the vertex weight
			var x = vertexWeightBeta * oldVertexBuffer[i * 3    ];
			var y = vertexWeightBeta * oldVertexBuffer[i * 3 + 1];
			var z = vertexWeightBeta * oldVertexBuffer[i * 3 + 2];
			// then for each connected edge add the other vertice too
			for (var j = 0; j < vertexValency; ++j) {
				const oppositeIndex = edgeMesh.edges[edgeMesh.vertices[i].e[j]].getOpposite(i);
				x += beta * oldVertexBuffer[oppositeIndex * 3    ];
				y += beta * oldVertexBuffer[oppositeIndex * 3 + 1];
				z += beta * oldVertexBuffer[oppositeIndex * 3 + 2];
			}
			// set the new vertice values
			newVertexBuffer[i * 3    ] = x;
			newVertexBuffer[i * 3 + 1] = y;
			newVertexBuffer[i * 3 + 2] = z;
		}

		// Step 2 - calculate new vertices from edge subdivision
		// the subdivision scheme is the following
		//     1/8
		//     / \
		//    /   \
		//   /     \
		// 3/8 --- 3/8
		//   \     /
		//    \   /
		//     \ /
		//     1/8
		for (var i = 0; i < oldEdgeCount; ++i) {
			const ev0 = edgeMesh.edges[i].v[0];
			const ev1 = edgeMesh.edges[i].v[1];
			const fv0 = edgeMesh.edges[i].ov[0];
			const fv1 = edgeMesh.edges[i].ov[1];
			var x = (3.0 / 8.0) * (oldVertexBuffer[ev0 * 3    ] + oldVertexBuffer[ev1 * 3    ]);
			var y = (3.0 / 8.0) * (oldVertexBuffer[ev0 * 3 + 1] + oldVertexBuffer[ev1 * 3 + 1]);
			var z = (3.0 / 8.0) * (oldVertexBuffer[ev0 * 3 + 2] + oldVertexBuffer[ev1 * 3 + 2]);
			x += (1.0 / 8.0) * (oldVertexBuffer[fv0 * 3    ] + oldVertexBuffer[fv1 * 3    ]);
			y += (1.0 / 8.0) * (oldVertexBuffer[fv0 * 3 + 1] + oldVertexBuffer[fv1 * 3 + 1]);
			z += (1.0 / 8.0) * (oldVertexBuffer[fv0 * 3 + 2] + oldVertexBuffer[fv1 * 3 + 2]);
			// new vertex index
			const nvi = oldVertCount + i;
			// set the new vertice values
			newVertexBuffer[nvi * 3    ] = x;
			newVertexBuffer[nvi * 3 + 1] = y;
			newVertexBuffer[nvi * 3 + 2] = z;
		}

		// Step 3 - calculate new indexes based on subdivision
		// ov2 --- nv1 --- ov1
		//   \     / \     /
		//    \   /   \   /
		//     \ /     \ /
		//     nv2 --- nv0
		//       \     /
		//        \   /
		//         \ /
		//         ov0
		// note: ov == old vertex; nv == new vertex
		// so the new indices are taken like this (each line is a new face)
		//  ov0  nv0  nv2
		//  nv0  ov1  nv1
		//  nv1  ov2  nv2
		//  nv0  nv1  nv2
		//
		var newIndexBuffer = new Uint16Array(newFaceCount * 3);
		for (var i = 0; i < oldFaceCount; ++i) {
			const ov0 = oldIndexBuffer[i * 3    ];
			const ov1 = oldIndexBuffer[i * 3 + 1];
			const ov2 = oldIndexBuffer[i * 3 + 2];
			// the new vertex indexes are obtained by the edge mesh's faces
			// since they hold indexes to edges - that is the same order in
			// which the new vertices are constructed in the new vertex buffer
			// so we need only the index and add the offset of the old vertices count
			const nv0 = oldVertCount + edgeMesh.faces[i].e[0];
			const nv1 = oldVertCount + edgeMesh.faces[i].e[1];
			const nv2 = oldVertCount + edgeMesh.faces[i].e[2];
			// now add the new vertices to the buffer
			const offset = i * 12; // 4 * 3

			newIndexBuffer[offset     ] = ov0;
			newIndexBuffer[offset +  1] = nv0;
			newIndexBuffer[offset +  2] = nv2;

			newIndexBuffer[offset +  3] = nv0;
			newIndexBuffer[offset +  4] = ov1;
			newIndexBuffer[offset +  5] = nv1;

			newIndexBuffer[offset +  6] = nv1;
			newIndexBuffer[offset +  7] = ov2;
			newIndexBuffer[offset +  8] = nv2;

			newIndexBuffer[offset +  9] = nv0;
			newIndexBuffer[offset + 10] = nv1;
			newIndexBuffer[offset + 11] = nv2;
		}

		retval.addAttribute('position', new THREE.BufferAttribute(newVertexBuffer, 3));
		retval.setIndex(new THREE.BufferAttribute(newIndexBuffer, 1));

		// deallocate the edge mesh
		delete edgeMesh;
		retval.computeBoundingSphere();
		retval.computeVertexNormals();
		return retval;
	}

	this.computeNormals
}

function subdivide(num) {
	if (!subdivider) {
		subdivider = new Subdivision(currentParams.originalGeometry);
	}
	if (num != currentParams.subdivAmount) {
		currentParams.subdivAmount = num;
		var subdivGeom = subdivider.subdivide(num)
		currentParams.mesh.geometry = subdivGeom;
	}
}

// Change events

function changeMeshGeometry() {
	if (subdivider) {
		subdivider.dispose();
		delete subdivider;
		subdivider = null;
		currentParams.subdivAmount = -1;
		params.subdivAmount = 0;
		paramControllers.subdivAmount.updateDisplay();
	}
	currentParams.originalGeometry = predefinedGeometries[params.geometry];
	currentParams.mesh.geometry = currentParams.originalGeometry;
}

function changeMeshMaterial() {
	switch (params.material) {
		case 'phongFlat':
			currentParams.mesh.material = currentParams.phongMatFlat;
			break;
		case 'phongSmooth':
			currentParams.mesh.material = currentParams.phongMatSmooth;
			break;
		case 'lambert':
			currentParams.mesh.material = currentParams.lambertMat;
			break;
		case 'normals':
			currentParams.mesh.material = currentParams.normalMat;
			break;
		case 'depth':
			currentParams.mesh.material = currentParams.depthMat;
			break;
		default:
			currentParams.mesh.material = currentParams.lambertMat;
			break;
	}
	currentParams.mesh.material.needsUpdate = true;
}

function changeMeshColor() {
	if (currentParams.mesh) {
		currentParams.meshColor = new THREE.Color(parseInt(params.meshColor.replace('#', '0x')));
		currentParams.phongMatFlat.color = currentParams.meshColor;
		currentParams.phongMatSmooth.color = currentParams.meshColor;
		currentParams.lambertMat.color = currentParams.meshColor;
	}
}

function changeMeshWireframe() {
	currentParams.phongMatFlat.wireframe = params.wireframe;
	currentParams.phongMatSmooth.wireframe = params.wireframe;
	currentParams.lambertMat.wireframe = params.wireframe;
	currentParams.normalMat.wireframe = params.wireframe;
	currentParams.depthMat.wireframe = params.wireframe;
}

function createPredefinedGeometries() {
	predefinedGeometries['tetrahedron'] = new THREE.TetrahedronGeometry(1);
	predefinedGeometries['cube'] = new THREE.BoxGeometry(1, 1, 1);
	predefinedGeometries['sphere'] = new THREE.SphereGeometry(1, 4, 4);
	predefinedGeometries['icosahedron'] = new THREE.IcosahedronGeometry(1);
	predefinedGeometries['dodecahedron'] = new THREE.DodecahedronGeometry(1);
	// init the irregular shapes too
	predefinedGeometries['plane'] = new THREE.PlaneGeometry(2, 2, 2, 2);
	predefinedGeometries['cone'] = new THREE.ConeGeometry(1, 2, 8);
	predefinedGeometries['ring'] = new THREE.RingGeometry(0.5, 1, 8, 2);
	predefinedGeometries['torus'] = new THREE.TorusGeometry(1, 0.3333333);
	predefinedGeometries['torusKnot'] = new THREE.TorusKnotGeometry(1, 0.2);
}

// WebGL initialization and implementation

window.addEventListener('load', init);

function init() {
	if (!Detector.webgl)
		Detector.addGetWebGLMessage();

	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 30 );

	controls = new THREE.OrbitControls(camera);
	controls.addEventListener('change', render);
	// some custom control settings
	controls.enablePan = false;
	controls.minDistance = 2;
	controls.maxDistance = 10;
	controls.zoomSpeed = 2.0;
	controls.target = new THREE.Vector3(0, 0, 0);

	camera.position.x = 5;

	// world
	scene = new THREE.Scene();

	// lights
	var light = new THREE.DirectionalLight( 0xffffff );
	light.position.set( 10, 5, 15 );
	scene.add( light );

	light = new THREE.DirectionalLight( 0x444444 );
	light.position.set( -10, -5, -15 );
	scene.add( light );

	light = new THREE.AmbientLight( 0x444444 );
	scene.add( light );

	// renderer
	renderer = new THREE.WebGLRenderer( {antialias: true } );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.shadowMap.enabled = true;

	container = document.getElementById('container');
	container.appendChild(renderer.domElement);

	stats = new Stats();
	stats.domElement.style.position = 'absolute';
	stats.domElement.style.top = '0px';
	stats.domElement.style.zIndex = 100;
	container.appendChild( stats.domElement );

	window.addEventListener( 'resize', onWindowResize, false );

	gui = new dat.GUI();
	gui.add(params, 'geometry', predefinedGeometriesNames).onChange(changeMeshGeometry);
	gui.add(params, 'material', ['phongFlat', 'phongSmooth', 'lambert', 'normals', 'depth']).onChange(changeMeshMaterial);
	gui.addColor(params, 'meshColor').name('color').onChange(changeMeshColor);
	gui.add(params, 'wireframe').onChange(changeMeshWireframe);
	paramControllers.subdivAmount = gui.add(params, 'subdivAmount', 0, subdivMax).step(1).onChange(subdivide);

	createPredefinedGeometries();

	updateScene();

	onWindowResize();

	animate();
}

function updateScene() {
	if (!currentParams.mesh) {
		currentParams.originalGeometry = predefinedGeometries.tetrahedron;
		currentParams.lambertMat = new THREE.MeshLambertMaterial({color: currentParams.meshColor});
		var commonPhongParams = {
			color: currentParams.meshColor,
			shininess: 40,
			specular: 0x222222
		};
		currentParams.phongMatFlat = new THREE.MeshPhongMaterial(commonPhongParams);
		currentParams.phongMatFlat.shading = THREE.FlatShading;
		currentParams.phongMatSmooth = new THREE.MeshPhongMaterial(commonPhongParams);
		currentParams.phongMatSmooth.shading = THREE.SmoothShading;
		currentParams.mesh = new THREE.Mesh(
			currentParams.originalGeometry
		);
		changeMeshMaterial();
		scene.add(currentParams.mesh);
	}
}

// GUI

function updateDatGui() {
	// TODO
}

// Render

function animate() {
	render();
	requestAnimationFrame(animate);
	controls.update();
}

function onWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
	render();
}

function render() {
	var dTime = Date.now() - startTime;
	updateScene();
	renderer.render( scene, camera );
	stats.update();
}

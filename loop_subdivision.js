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
var info;
var infoDirty = false;

var fopen;
var loadManager;
var objLoader;

// some constants
const epsilon = 1e-6;
const subdivMax = 8;
const uint16Max = 65535;
const uint32Max = 4294967295;
const defaultRadius = 4; //!< default radius of geometries

var params = {
	geometry: 'tetrahedron',
	subdivAmount: 0,
	material: 'phongFlat',
	meshColor: '#0080ff',
	surface: true,
	wireColor: '#ffffff',
	wireframe: true,
	originalColor: '#ff20ff',
	original: true,
	backgroundColor: '#3a3a3a',
	autoRotate: false,
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
	'teapot',
	'bunny',
	'OBJ file...',
];

var predefinedGeometries = [];

var materialNames = [
	'phongFlat',
	'phongSmooth',
	'lambert',
	'normal',
];

var materials = [];

var currentParams = {
	currentGeometryName: params.geometry,
	subdivAmount: -1,
	originalGeometry: null,
	currentGeometry: null,
	mesh: null,
	wireMesh: null,
	origMesh: null,
	wireMat: null,
	origMat: null,
	meshColor: new THREE.Color(parseInt(params.meshColor.replace('#', '0x'))),
	wireColor: new THREE.Color(parseInt(params.wireColor.replace('#', '0x'))),
	originalColor: new THREE.Color(parseInt(params.originalColor.replace('#', '0x'))),
	backgroundColor: new THREE.Color(parseInt(params.backgroundColor.replace('#', '0x'))),
	material: params.material,
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
	this.edgeMap = []; // hash map for faster edge look up to avoid double loop and thus n * n complexity

	// v0 - index of the first vertex
	// v1 - index of the second vertex
	// fi - index of the face
	// ei - index of the edge in the face
	// ov - opposite vertex of the edge for the current face
	this.processEdge = function(v0, v1, fi, ei, ov) {
		const minV = Math.min(v0, v1);
		const maxV = Math.max(v0, v1);
		var edgeIndex = -1;
		var edgeKey = minV.toString() + '_' + maxV.toString();
		if (edgeKey in this.edgeMap) {
			edgeIndex = this.edgeMap[edgeKey];
		} else {
			this.edgeMap[edgeKey] = this.edges.length; // this will be the new edge index
		}
		// now if there was no index found this is a new edge
		if (-1 == edgeIndex) {
			var edge = new EMEdge;
			edge.v[0] = minV;
			edge.v[1] = maxV;
			edge.f[0] = fi;
			edge.ov[0] = ov;
			edge.f[1] = uint32Max; // invalid value for connectivity checks later
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
		var indices = new Uint32Array(geometry.faces.length * 3);
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
	this.info = [{
		vertexCount: this.initialGeometry.getAttribute('position').array.length / 3,
		faceCount: this.initialGeometry.getIndex().array.length / 3
	}];

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
			this.info[num] = {
				vertexCount: subdivided.getAttribute('position').array.length / 3,
				faceCount: subdivided.getIndex().array.length / 3
			};
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

		// Step 3 - calculate new indices based on subdivision
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
		var newIndexBuffer = new Uint32Array(newFaceCount * 3);
		for (var i = 0; i < oldFaceCount; ++i) {
			const ov0 = oldIndexBuffer[i * 3    ];
			const ov1 = oldIndexBuffer[i * 3 + 1];
			const ov2 = oldIndexBuffer[i * 3 + 2];
			// the new vertex indices are obtained by the edge mesh's faces
			// since they hold indices to edges - that is the same order in
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
		currentParams.currentGeometry = subdivGeom;
		currentParams.mesh.geometry = currentParams.currentGeometry;
		currentParams.wireMesh.geometry = currentParams.currentGeometry;
		// change the visibility of the original mesh
		currentParams.origMesh.visible = params.original && num > 0;
		updateInfo();
	}
}

// Change events

function updateInfo() {
	info.innerHTML = 'Orignal vertices: ' + subdivider.info[0].vertexCount + ' | Original faces: ' + subdivider.info[0].faceCount;
	info.innerHTML += '<br>Current subdivision amount: ' + currentParams.subdivAmount;
	info.innerHTML += '<br>Current vertices: ' + subdivider.info[currentParams.subdivAmount].vertexCount;
	info.innerHTML += ' | Current faces: ' + subdivider.info[currentParams.subdivAmount].faceCount;
}

function changeMeshFromGeometry(geometry) {
	if (subdivider) {
		subdivider.dispose();
		delete subdivider;
		subdivider = null;
		currentParams.subdivAmount = -1;
		params.subdivAmount = 0;
		paramControllers.subdivAmount.updateDisplay();
	}
	currentParams.originalGeometry = geometry;
	currentParams.origMesh.geometry = currentParams.originalGeometry;
	currentParams.origMesh.visible = false;
	// create a new subdivider
	subdivider = new Subdivision(currentParams.originalGeometry);
	currentParams.currentGeometry = subdivider.subdivide(0);
	currentParams.subdivAmount = 0;
	currentParams.mesh.geometry = currentParams.currentGeometry;
	currentParams.wireMesh.geometry = currentParams.currentGeometry;
	updateInfo();
}

function changeMeshGeometry() {
	// if the current geometry type is already an OBJ file, we should dispose of it first
	if (currentParams.currentGeometryName == 'OBJ file...') {
		currentParams.originalGeometry.dispose();
		currentParams.currentGeometryName = '';
	}
	if (params.geometry == 'OBJ file...') {
		fopen.click();
	} else {
		changeMeshFromGeometry(predefinedGeometries[params.geometry]);
		currentParams.currentGeometryName = params.geometry;
	}
}

// normalizes a geometry so it is centered in (0, 0, 0) and the
// radius of its bounding sphere is the defaultRadius
function normalizeGeometry(geom) {
	// first compute the bounding sphere - it will give us both current radius
	// and center of the object
	geom.computeBoundingSphere();
	// the scale factor is obtained the sphere radius
	const scaleFactor = defaultRadius / geom.boundingSphere.radius;
	// now scale all the vertices by the scale factor
	for (var i = 0, il = geom.vertices.length; i < il; ++i) {
		geom.vertices[i].multiplyScalar(scaleFactor);
	}
	// now compute the bounding sphere again
	geom.computeBoundingSphere();
	// now use its center as offset for centering the geometry
	var offset = geom.boundingSphere.center;
	offset.negate();
	for (var i = 0, il = geom.vertices.length; i < il; ++i) {
		geom.vertices[i].add(offset);
	}
	// finaly compute the bounding sphere again, just to be correct
	geom.computeBoundingSphere();
}

function onFileSelect() {
	var objNum = 0;
	var objFile = fopen.files[0];
	var objURL = window.URL.createObjectURL(objFile);
	objLoader.load(objURL,
		// on object
		function(object) {
			// load only the first object
			if (objNum < 1) {
				// ... and only the first mesh from the object
				var geom = object.children[0].geometry;
				var stdGeom = new THREE.Geometry().fromBufferGeometry(geom);
				stdGeom.computeFaceNormals();
				stdGeom.mergeVertices();
				stdGeom.computeVertexNormals();
				normalizeGeometry(stdGeom);
				changeMeshFromGeometry(stdGeom);
				// change the name of the current geometry so we could dispose of it
				// properly later
				currentParams.currentGeometryName = 'OBJ file...';
				geom.dispose();
				objNum++;
				infoDirty = true;
			}
		},
		// on progress
		function(xhr) {},
		// on error
		function(xhr) {
			info.innerHTML = 'Error loading file';
		}
	);
}

function loadAsset(predefinedName, assetUrl) {
	objLoader.load(assetUrl,
		function(object) {
			var geom = object.children[0].geometry;
			var stdGeom = new THREE.Geometry().fromBufferGeometry(geom);
			stdGeom.computeFaceNormals();
			stdGeom.mergeVertices();
			stdGeom.computeVertexNormals();
			normalizeGeometry(stdGeom);
			predefinedGeometries[predefinedName] = stdGeom;
		}
	);
}

function changeMeshMaterial() {
	currentParams.mesh.material = materials[params.material];
	currentParams.material = params.material;
	currentParams.mesh.material.needsUpdate = true;
}

function changeMeshColor() {
	currentParams.meshColor = new THREE.Color(parseInt(params.meshColor.replace('#', '0x')));
	materials['phongFlat'].color = currentParams.meshColor;
	materials['phongSmooth'].color = currentParams.meshColor;
	materials['lambert'].color = currentParams.meshColor;
	currentParams.mesh.material.needsUpdate = true;
}

function changeWireMeshColor() {
	info.style.color = params.wireColor;
	currentParams.wireColor = new THREE.Color(parseInt(params.wireColor.replace('#', '0x')));
	currentParams.wireMat.color = currentParams.wireColor;
	currentParams.wireMat.needsUpdate = true;
}

function changeOriginalColor() {
	currentParams.originalColor = new THREE.Color(parseInt(params.originalColor.replace('#', '0x')));
	currentParams.origMat.color = currentParams.originalColor;
	currentParams.origMat.needsUpdate = true;
}

function changeBackgroundColor() {
	currentParams.backgroundColor = new THREE.Color(parseInt(params.backgroundColor.replace('#', '0x')));
	renderer.setClearColor(currentParams.backgroundColor);
}

function changeMeshSurface() {
	currentParams.mesh.visible = params.surface;
}

function changeMeshWireframe() {
	currentParams.wireMesh.visible = params.wireframe;
}

function changeMeshOriginal() {
	currentParams.origMesh.visible = params.original && currentParams.subdivAmount > 0;
}

function createDefaultGeometry() {
	currentParams.originalGeometry = predefinedGeometries[params.geometry];
	subdivider = new Subdivision(currentParams.originalGeometry);
	currentParams.currentGeometry = subdivider.subdivide(0);
	currentParams.subdivAmount = 0;
	currentParams.mesh = new THREE.Mesh(
		currentParams.currentGeometry
	);
	changeMeshMaterial();
	scene.add(currentParams.mesh);
	// create the wireframe mesh
	currentParams.wireMesh = new THREE.Mesh(
		currentParams.currentGeometry,
		currentParams.wireMat
	);
	scene.add(currentParams.wireMesh);
	// create the original mesh
	currentParams.origMesh = new THREE.Mesh(
		currentParams.originalGeometry,
		currentParams.origMat
	);
	currentParams.origMesh.visible = false;
	scene.add(currentParams.origMesh);
}

function createPredefinedGeometries() {
	predefinedGeometries['tetrahedron'] = new THREE.TetrahedronGeometry(defaultRadius);
	predefinedGeometries['cube'] = new THREE.BoxGeometry(defaultRadius, defaultRadius, defaultRadius);
	predefinedGeometries['sphere'] = new THREE.SphereGeometry(defaultRadius, 16, 9);
	predefinedGeometries['icosahedron'] = new THREE.IcosahedronGeometry(defaultRadius);
	predefinedGeometries['dodecahedron'] = new THREE.DodecahedronGeometry(defaultRadius);
	// init the irregular shapes too
	predefinedGeometries['plane'] = new THREE.PlaneGeometry(defaultRadius * 2, 2, 2, 2);
	predefinedGeometries['cone'] = new THREE.ConeGeometry(defaultRadius, 8, 8);
	predefinedGeometries['ring'] = new THREE.RingGeometry(defaultRadius / 2, defaultRadius, 8, 2);
	predefinedGeometries['torus'] = new THREE.TorusGeometry(defaultRadius, 1);
	predefinedGeometries['torusKnot'] = new THREE.TorusKnotGeometry(defaultRadius, defaultRadius / 5);
	// fixup some geometries that are not indexed properly
	predefinedGeometries['sphere'].mergeVertices();
	predefinedGeometries['ring'].mergeVertices();
	predefinedGeometries['torus'].mergeVertices();
	// load obj assets
	loadAsset('teapot', 'assets/teapot.obj');
	loadAsset('bunny', 'assets/bunny.obj');
}

function createMaterials() {
	var commonPhongParams = {
		color: currentParams.meshColor,
		shininess: 40,
		specular: 0x222222
	};
	materials['phongFlat'] = new THREE.MeshPhongMaterial(commonPhongParams);
	materials['phongFlat'].shading = THREE.FlatShading;
	materials['phongSmooth'] = new THREE.MeshPhongMaterial(commonPhongParams);
	materials['phongSmooth'].shading = THREE.SmoothShading;
	materials['lambert'] = new THREE.MeshLambertMaterial({color: currentParams.meshColor});
	materials['normal'] = new THREE.MeshNormalMaterial();
	// create the wireframe material
	currentParams.wireMat = new THREE.MeshBasicMaterial({
		color: currentParams.wireColor,
		wireframe: true
	});
	currentParams.origMat = new THREE.MeshBasicMaterial({
		color: currentParams.originalColor,
		wireframe: true
	});
}

function changeAutoRotation() {
	if (!params.autoRotate) {
		currentParams.mesh.rotation.x = 0;
		currentParams.mesh.rotation.y = 0;
		currentParams.wireMesh.rotation.x = 0;
		currentParams.wireMesh.rotation.y = 0;
		currentParams.origMesh.rotation.x = 0;
		currentParams.origMesh.rotation.y = 0;
		startTime = Date.now();
	}
}

// WebGL initialization and implementation

window.addEventListener('load', init);

function init() {
	if (!Detector.webgl)
		Detector.addGetWebGLMessage();

	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, defaultRadius * 10);

	controls = new THREE.OrbitControls(camera);
	controls.addEventListener('change', render);
	// some custom control settings
	controls.enablePan = false;
	controls.minDistance = defaultRadius / 4.0;
	controls.maxDistance = defaultRadius * 4.0;
	controls.zoomSpeed = defaultRadius / 2.0;
	controls.target = new THREE.Vector3(0, 0, 0);

	camera.position.x = defaultRadius * 2.5;

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
	renderer.setClearColor(currentParams.backgroundColor);

	container = document.getElementById('container');
	container.appendChild(renderer.domElement);

	info = document.createElement('div');
	info.style.position = 'absolute';
	info.style.top = '10px';
	info.style.width = '100%';
	info.style.textAlign = 'center';
	info.style.color = '#ffffff';
	info.innerHTML = '';
	container.appendChild(info);

	fopen = document.createElement('input');
	fopen.type = 'file';
	fopen.accept = '.obj';
	fopen.multiple = '';
	fopen.style.visibility = 'hidden';
	fopen.onchange = onFileSelect;

	stats = new Stats();
	stats.domElement.style.position = 'absolute';
	stats.domElement.style.top = '0px';
	stats.domElement.style.zIndex = 100;
	container.appendChild( stats.domElement );

	window.addEventListener( 'resize', onWindowResize, false );

	gui = new dat.GUI();
	gui.add(params, 'geometry', predefinedGeometriesNames).onChange(changeMeshGeometry);
	paramControllers.subdivAmount = gui.add(params, 'subdivAmount', 0, subdivMax).step(1).onChange(subdivide);
	gui.add(params, 'material', materialNames).onChange(changeMeshMaterial);
	gui.addColor(params, 'meshColor').name('color').onChange(changeMeshColor);
	gui.add(params, 'surface').onChange(changeMeshSurface);
	gui.addColor(params, 'wireColor').name('wire color').onChange(changeWireMeshColor);
	gui.add(params, 'wireframe').onChange(changeMeshWireframe);
	gui.addColor(params, 'originalColor').name('original color').onChange(changeOriginalColor);
	gui.add(params, 'original').onChange(changeMeshOriginal);
	gui.addColor(params, 'backgroundColor').name('background color').onChange(changeBackgroundColor);
	gui.add(params, 'autoRotate').onChange(changeAutoRotation);

	loadManager = new THREE.LoadingManager();
	loadManager.onProgress = function(item, loaded, total) {
		info.innerHTML = 'Loading ' + item.toString() + ' : ' + (loaded * 100) / total + ' %';
	};

	objLoader = new THREE.OBJLoader(loadManager);

	createPredefinedGeometries();
	createMaterials();
	createDefaultGeometry();

	updateInfo();

	updateScene();

	onWindowResize();

	animate();
}

function updateScene() {
	if (infoDirty) {
		updateInfo();
		infoDirty = false;
	}
	if (params.autoRotate) {
		var dTime = (Date.now() - startTime) * 0.0005;
		currentParams.mesh.rotation.x = dTime;
		currentParams.mesh.rotation.y = dTime;
		currentParams.wireMesh.rotation.x = dTime;
		currentParams.wireMesh.rotation.y = dTime;
		currentParams.origMesh.rotation.x = dTime;
		currentParams.origMesh.rotation.y = dTime;
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
	updateScene();
	renderer.render( scene, camera );
	stats.update();
}

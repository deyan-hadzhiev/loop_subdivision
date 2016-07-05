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

var params = {
	geometry: 'tetrahedron',
	material: 'phong',
	meshColor: '#0080ff',
	wireframe: false,
	smooth: true,
	subdivAmount: 0,
};

var paramControllers = {
	subdivAmount: null,
}

var predefinedGeometries = {
	tetrahedron: null,
	cube: null,
	sphere: null,
	icosahedron: null,
	dodecahedron: null,
}

var currentParams = {
	subdivAmount: -1,
	originalGeometry: null,
	mesh: null,
	meshColor: new THREE.Color(parseInt(params.meshColor.replace('#', '0x'))),
	phongMat: null,
	lambertMat: null,
	normalMat: new THREE.MeshNormalMaterial(),
	depthMat: new THREE.MeshDepthMaterial(),
};

// Subdivision

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
		// TODO : real implementation
		var oldVertices = buffGeom.getAttribute('position').array;
		var newVertices = new Float32Array(oldVertices.length);
		for (var i = 0, il = oldVertices.length; i < il; ++i) {
			newVertices[i] = oldVertices[i] * 1.2;
		}
		retval.addAttribute('position', new THREE.BufferAttribute(newVertices, 3));
		// copy the indices directly
		var newIndices = new Uint16Array(buffGeom.getIndex('index').array);
		retval.setIndex(new THREE.BufferAttribute(newIndices, 1));
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
	switch (params.geometry) {
		case 'tetrahedron':
			currentParams.originalGeometry = predefinedGeometries.tetrahedron;
			break;
		case 'cube':
			currentParams.originalGeometry = predefinedGeometries.cube;
			break;
		case 'sphere':
			currentParams.originalGeometry = predefinedGeometries.sphere;
			break;
		case 'icosahedron':
			currentParams.originalGeometry = predefinedGeometries.icosahedron;
			break;
		case 'dodecahedron':
			currentParams.originalGeometry = predefinedGeometries.dodecahedron;
			break;
	}
	currentParams.mesh.geometry = currentParams.originalGeometry;
}

function changeMeshMaterial() {
	switch (params.material) {
		case 'phong':
			currentParams.mesh.material = currentParams.phongMat;
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
		currentParams.phongMat.color = currentParams.meshColor;
		currentParams.lambertMat.color = currentParams.meshColor;
	}
}

function changeMeshWireframe() {
	currentParams.phongMat.wireframe = params.wireframe;
	currentParams.lambertMat.wireframe = params.wireframe;
	currentParams.normalMat.wireframe = params.wireframe;
	currentParams.depthMat.wireframe = params.wireframe;
}

function changeMeshShading() {
	currentParams.phongMat.shading = (params.smooth ? THREE.SmoothShading : THREE.FlatShading);
	currentParams.phongMat.needsUpdate = true;
}

function createPredefinedGeometries() {
	predefinedGeometries.tetrahedron = new THREE.TetrahedronGeometry(1);
	predefinedGeometries.cube = new THREE.BoxGeometry(1, 1, 1);
	predefinedGeometries.sphere = new THREE.SphereGeometry(1, 4, 4);
	predefinedGeometries.icosahedron = new THREE.IcosahedronGeometry(1);
	predefinedGeometries.dodecahedron = new THREE.DodecahedronGeometry(1);
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
	gui.add(params, 'geometry', ['tetrahedron', 'cube', 'sphere', 'icosahedron', 'dodecahedron']).onChange(changeMeshGeometry);
	gui.add(params, 'material', ['phong', 'lambert', 'normals', 'depth']).onChange(changeMeshMaterial);
	gui.addColor(params, 'meshColor').name('color').onChange(changeMeshColor);
	gui.add(params, 'wireframe').onChange(changeMeshWireframe);
	gui.add(params, 'smooth').onChange(changeMeshShading);
	paramControllers.subdivAmount = gui.add(params, 'subdivAmount', 0, subdivMax).step(1).onChange(subdivide);

	createPredefinedGeometries();

	updateScene();

	onWindowResize();

	animate();
}

function updateScene() {
	if (!currentParams.mesh) {
		currentParams.originalGeometry = predefinedGeometries.tetrahedron;
		currentParams.lambertMat = new THREE.MeshLambertMaterial({color: currentParams.meshColor}),
		currentParams.mesh = new THREE.Mesh(
			currentParams.originalGeometry,
			currentParams.lambertMat
		);
		currentParams.phongMat = new THREE.MeshPhongMaterial({
			color: currentParams.meshColor,
			shininess: 40,
			specular: 0x222222
		});
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

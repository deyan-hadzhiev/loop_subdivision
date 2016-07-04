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

var params = {
	material: 'phong',
	meshColor: '#0080ff',
	wireframe: false,
	smooth: true
};

var currentParams = {
	mesh: null,
	meshColor: new THREE.Color(parseInt(params.meshColor.replace('#', '0x'))),
	phongMat: null,
	lambertMat: null,
	normalMat: new THREE.MeshNormalMaterial(),
	depthMat: new THREE.MeshDepthMaterial(),
};

// Subdivision

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
	gui.add(params, 'material', ['phong', 'lambert', 'normals', 'depth']).onChange(changeMeshMaterial);
	gui.addColor(params, 'meshColor').name('color').onChange(changeMeshColor);
	gui.add(params, 'wireframe').onChange(changeMeshWireframe);
	gui.add(params, 'smooth').onChange(changeMeshShading);

	updateScene();

	onWindowResize();

	animate();
}

function updateScene() {
	if (!currentParams.mesh) {
		currentParams.lambertMat = new THREE.MeshLambertMaterial({color: currentParams.meshColor}),
		currentParams.mesh = new THREE.Mesh(
			new THREE.CubeGeometry(2, 2, 2),
			//new THREE.SphereGeometry(1, 20, 20),
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

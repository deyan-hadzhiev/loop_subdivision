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
	wireframe: false,
	material: 'lambert',
	meshColor: '#0080ff'
};

var currentParams = {
	mesh: null,
	meshColor: new THREE.Color(parseInt(params.meshColor.replace('#', '0x'))),
	lambertMat: null,
	normalMat: new THREE.MeshNormalMaterial(),
	wireframe: null,
};

// Subdivision

function changeMeshColor() {
	if (currentParams.mesh) {
		currentParams.meshColor = new THREE.Color(parseInt(params.meshColor.replace('#', '0x')));
		currentParams.lambertMat.color = currentParams.meshColor;
		if (currentParams.wireframe) {
			scene.remove(currentParams.wireframe);
			delete currentParams.wireframe;
			currentParams.wireframe = new THREE.WireframeHelper(currentParams.mesh, currentParams.meshColor);
			scene.add(currentParams.wireframe);
		}
	}
}

function changeMeshMaterial() {
	switch (params.material) {
		case 'lambert':
			currentParams.mesh.material = currentParams.lambertMat;
			break;
		case 'normals':
			currentParams.mesh.material = currentParams.normalMat;
			break;
		default:
			currentParams.mesh.matere = currentParams.lambertMat;
			break;
	}
}

function changeMeshWireframe() {
	if (params.wireframe) {
		currentParams.wireframe = new THREE.WireframeHelper(currentParams.mesh, currentParams.meshColor);
		scene.add(currentParams.wireframe);
	} else {
		if (currentParams.wireframe) {
			scene.remove(currentParams.wireframe);
			delete currentParams.wireframe;
			currentParams.wireframe = null;
		}
	}
	currentParams.mesh.visible = !params.wireframe;
}

// WebGL initialization and implementation

window.addEventListener('load', init);

function init() {
	if (!Detector.webgl)
		Detector.addGetWebGLMessage();

	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

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

	container = document.getElementById('container');
	container.appendChild(renderer.domElement);

	stats = new Stats();
	stats.domElement.style.position = 'absolute';
	stats.domElement.style.top = '0px';
	stats.domElement.style.zIndex = 100;
	container.appendChild( stats.domElement );

	window.addEventListener( 'resize', onWindowResize, false );

	gui = new dat.GUI();
	gui.add(params, 'wireframe').onChange(changeMeshWireframe);
	gui.add(params, 'material', ['lambert', 'normals']).onChange(changeMeshMaterial);
	gui.addColor(params, 'meshColor').name('color').onChange(changeMeshColor);

	updateScene();

	onWindowResize();

	animate();
}

function updateScene() {
	if (!currentParams.mesh) {
		currentParams.lambertMat = new THREE.MeshLambertMaterial({color: currentParams.meshColor}),
		currentParams.mesh = new THREE.Mesh(
			new THREE.CubeGeometry(2, 2, 2),
			currentParams.lambertMat
		);
		scene.add(currentParams.mesh);
		currentParams.wireframe = new THREE.WireframeHelper(currentParams.mesh, currentParams.meshColor);
		scene.add(currentParams.wireframe);
		currentParams.wireframe.visible = false;
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

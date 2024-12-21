import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Import the GLB file
import modelPath from '/public/Xbot.glb';

let scene, camera, renderer, clock;
let model, mixer;
let currentAction = 'idle';
let actions = {};
let moveForward = false;
let moveBackward = false;
let rotateLeft = false;
let rotateRight = false;
const walkSpeed = 2; // Movement speed
const rotateSpeed = Math.PI / 2; // Rotation speed (radians per second)

init();
animate();

function init() {
    // Scene Setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa0a0a0);
    scene.fog = new THREE.Fog(0xa0a0a0, 10, 50);

    // Camera
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100);
    camera.position.set(0, 2, -5); // Start behind the character

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Soft shadows
    document.body.appendChild(renderer.domElement);

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    hemiLight.position.set(0, 50, 0); // Higher hemisphere light
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2); // Increased intensity
    dirLight.position.set(10, 50, 10); // Higher position
    dirLight.castShadow = true;

    dirLight.shadow.mapSize.width = 2048; // Higher resolution shadows
    dirLight.shadow.mapSize.height = 2048;

    dirLight.shadow.camera.top = 20;
    dirLight.shadow.camera.bottom = -20;
    dirLight.shadow.camera.left = -20;
    dirLight.shadow.camera.right = 20;
    dirLight.shadow.camera.near = 0.1;
    dirLight.shadow.camera.far = 100;

    scene.add(dirLight);

    // Grid Ground
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(100, 100),
        new THREE.MeshPhongMaterial({ color: 0xcbcbcb, depthWrite: false })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true; // Enable ground to receive shadows
    scene.add(ground);

    const gridHelper = new THREE.GridHelper(100, 100, 0x000000, 0x000000);
    gridHelper.material.opacity = 0.25; // Slight transparency for a cleaner look
    gridHelper.material.transparent = true;
    scene.add(gridHelper);

    // Clock
    clock = new THREE.Clock();

    // Load Model
    loadModel();

    // Resize Event
    window.addEventListener('resize', onWindowResize);

    // Key Events
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
}

function loadModel() {
    const loader = new GLTFLoader();
    loader.load(
        modelPath, // Use the imported path from Vite
        (gltf) => {
            model = gltf.scene;
            model.position.set(0, 0, 0); // Ensure character starts on the ground
            model.castShadow = true; // Enable shadow casting
            scene.add(model);

            model.traverse((object) => {
                if (object.isMesh) object.castShadow = true;
            });

            // Skeleton Helper
            const skeleton = new THREE.SkeletonHelper(model);
            skeleton.visible = false;
            scene.add(skeleton);

            // Animation Mixer
            mixer = new THREE.AnimationMixer(model);

            // Actions
            gltf.animations.forEach((clip) => {
                const action = mixer.clipAction(clip);
                actions[clip.name] = action;

                if (clip.name === 'idle') {
                    action.play();
                }
            });
        },
        undefined,
        (error) => {
            console.error('An error occurred while loading the model:', error);
        }
    );
}

function setAction(name) {
    if (currentAction !== name) {
        const current = actions[currentAction];
        const next = actions[name];

        if (current) current.fadeOut(0.5);
        if (next) next.reset().fadeIn(0.5).play();

        currentAction = name;
    }
}

function onKeyDown(event) {
    if (event.key === 'w') {
        moveForward = true;
        setAction('walk');
    }
    if (event.key === 's') {
        moveBackward = true;
        setAction('walk');
    }
    if (event.key === 'a' && (moveForward || moveBackward)) {
        rotateLeft = true;
    }
    if (event.key === 'd' && (moveForward || moveBackward)) {
        rotateRight = true;
    }
}

function onKeyUp(event) {
    if (event.key === 'w') {
        moveForward = false;
        setAction('idle');
    }
    if (event.key === 's') {
        moveBackward = false;
        setAction('idle');
    }
    if (event.key === 'a') {
        rotateLeft = false;
    }
    if (event.key === 'd') {
        rotateRight = false;
    }
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    if (mixer) mixer.update(delta);

    if (moveForward && model) {
        // Move forward in the direction the model is facing
        const forward = new THREE.Vector3(0, 0, 1);
        forward.applyQuaternion(model.quaternion);
        model.position.add(forward.multiplyScalar(walkSpeed * delta));
    }

    if (moveBackward && model) {
        // Move backward in the direction the model is facing
        const backward = new THREE.Vector3(0, 0, -1);
        backward.applyQuaternion(model.quaternion);
        model.position.add(backward.multiplyScalar(walkSpeed * delta));
    }

    if (rotateLeft && model) {
        // Rotate left
        model.rotation.y += rotateSpeed * delta;
    }

    if (rotateRight && model) {
        // Rotate right
        model.rotation.y -= rotateSpeed * delta;
    }

    if (model) {
        // Smooth camera follow
        const offset = new THREE.Vector3(0, 1, -5); // Camera behind the character
        const targetPosition = model.position.clone().add(
            offset.setY(offset.y + 2).applyQuaternion(model.quaternion)
        );
        camera.position.lerp(targetPosition, 0.1); // Smoothly interpolate to the target position
        camera.lookAt(model.position.clone().add(new THREE.Vector3(0, 2, 0)));
    }

    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

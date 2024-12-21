import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { io } from 'https://cdn.socket.io/4.4.1/socket.io.esm.min.js';

let modelPath;
let eggPath;

if (window.location.pathname.includes('/public/')) {
    modelPath = '/public/Xbot.glb';
} else {
    modelPath = '/Xbot.glb';
}

if (window.location.pathname.includes('/public/')) {
    eggPath = '/public/egg.glb';
} else {
    eggPath = '/egg.glb';
}

console.log(`Model Path: ${modelPath}`); // For debugging purposes

const socket = io('https://full-canary-chokeberry.glitch.me/');

let scene, camera, renderer, clock;
let localModel, localMixer;
let currentAction = 'idle';
let localActions = {};
let moveForward = false;
let moveBackward = false;
let rotateLeft = false;
let rotateRight = false;
let isRunning = false; // Track if the player is running
let lastState = {};
const keyStates = {
    w: false,
    a: false,
    s: false,
    d: false,
    Shift: false,
};
const walkSpeed = 2;
const runSpeed = 5; // Higher speed for running
const rotateSpeed = Math.PI / 2;
const loadingPlayers = new Set(); // Track players being loaded
const loadingEggs = new Set(); // Track eggs currently being loaded
const players = {};
let localEgg = null; // To track the local egg
let canPlaceEgg = true; // Ensure only one egg per user
let eggs = {}; // Track all remote eggs
let myId = null;

init();
animate();

function init() {
    // Scene setup
    scene = new THREE.Scene();

    scene.background = new THREE.Color(0xa0a0a0);
    scene.fog = new THREE.Fog(0xa0a0a0, 10, 50);

    // Camera
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100);
    camera.position.set(0, 2, -5);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
    hemiLight.position.set(0, 50, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(10, 50, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024); // Reduced resolution
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

    // Load Local Model
    loadLocalModel();

    // Key Events
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Window resize
    window.addEventListener('resize', onWindowResize);

    // Socket setup
    setupSocketEvents();
}

function loadLocalModel() {
    const loader = new GLTFLoader();
    loader.load(
        modelPath,
        (gltf) => {
            const spawnPoint = getRandomSpawnPoint();
            localModel = gltf.scene;
            localModel.position.set(spawnPoint.x, 0, spawnPoint.z);
            localModel.rotation.y = spawnPoint.rotation;
            localModel.castShadow = true;
            scene.add(localModel);

            localModel.traverse((object) => {
                if (object.isMesh) object.castShadow = true;
            });

            // Initialize animation mixer
            localMixer = new THREE.AnimationMixer(localModel);
            gltf.animations.forEach((clip) => {
                const action = localMixer.clipAction(clip);
                localActions[clip.name] = action;

                if (clip.name === 'idle') {
                    action.play();
                }
            });

            // Notify server about the new player
            socket.emit('player_joined', {
                x: spawnPoint.x,
                z: spawnPoint.z,
                rotation: spawnPoint.rotation,
                action: 'idle',
            });
        },
        undefined,
        (error) => console.error('Error loading local model:', error)
    );
}

function isEggPlacementValid(position) {
    // Example collision detection logic
    const buffer = 1; // Minimum distance between eggs or players
    for (const id in eggs) {
        const egg = eggs[id];
        if (egg.position.distanceTo(position) < buffer) {
            return false; // Too close to another egg
        }
    }
    for (const id in players) {
        const player = players[id];
        if (player.position.distanceTo(position) < buffer) {
            return false; // Too close to a player
        }
    }
    return true;
}

function placeEgg() {
    if (localModel && canPlaceEgg) {
        const eggPosition = localModel.position.clone();
        if (isEggPlacementValid(eggPosition)) {
            createLocalEgg(eggPosition);

            socket.emit('create_egg', {
                x: eggPosition.x,
                z: eggPosition.z,
                rotation: localModel.rotation.y,
            });

            canPlaceEgg = false; // Prevent further egg creation
        } else {
            console.warn('Invalid egg placement.');
        }
    }
}


function createLocalEgg(position) {
    const loader = new GLTFLoader();
    loader.load(
        eggPath,
        (gltf) => {
            const eggModel = gltf.scene;
            eggModel.position.copy(position);
            eggModel.rotation.y = localModel.rotation.y;
            eggModel.castShadow = true;

            localEgg = {
                model: eggModel,
                position: position.clone(),
                rotation: localModel.rotation.y,
            };

            scene.add(eggModel); // Add egg to the scene
        },
        undefined,
        (error) => console.error('Error loading local egg:', error)
    );
}

function updateState(data) {
    updatePlayers(data.players || {});
    updateEggs(data.eggs || {});
}

function setupSocketEvents() {
    socket.on('init', (data) => {
        console.log('Init data:', data);
        myId = data.id;
        updatePlayers(data.players);
        updateEggs(data.eggs); // Initialize existing eggs
    });

    // Server emits a combined state update
    socket.on('state_update_all', (data) => {
        updateState(data);
    });

    socket.on('new_player', (data) => {
        console.log('New Player data:', data);
        addOrUpdatePlayer(data.id, data);
    });

    socket.on('new_egg', (data) => {
        console.log('New Egg data:', data);
        addOrUpdateEgg(data.id, data);
    });

    socket.on('state_update_eggs', (data) => {
        updateEggs(data); // Update the eggs' state dynamically
    });

    socket.on('egg_disconnected', (id) => {
        console.log('Egg Disconnected:', id);
        removeRemoteEgg(id); // Remove the egg associated with the given ID
    });

    socket.on('state_update', (data) => {
        console.log('State Update:', data);
        if (players[data.id]) {
            players[data.id].targetX = data.x;
            players[data.id].targetZ = data.z;
            players[data.id].targetRotation = data.rotation || 0;
        }
    });

    socket.on('player_disconnected', (id) => {
        console.log('Player Disconnected:', id);
        removeRemotePlayer(id);
        removeRemoteEgg(id); // Remove any egg placed by the disconnected player
    });

    socket.on('update_egg', (data) => {
        console.log('Egg Update:', data);
        addOrUpdateEgg(data.id, data); // Update the position or state of the egg
    });
    
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);

        // Remove the player from the players object
        delete players[socket.id];

        // Remove the egg associated with the player
        delete eggs[socket.id];

        // Notify remaining clients about the disconnection
        socket.broadcast.emit('player_disconnected', socket.id);

        // Notify remaining clients to remove the player's egg
        socket.broadcast.emit('egg_disconnected', socket.id);
    });
}


function addOrUpdateEgg(id, data) {
    if (!eggs[id]) {
        createRemoteEgg(id, data); // Create if doesn't exist
    } else {
        updateRemoteEgg(id, data); // Update if it exists
    }
}


function addOrUpdatePlayer(id, data) {
    if (!players[id]) {
        // Create a new remote player
        createRemotePlayer(id, data);
    } else {
        // Update existing remote player
        updateRemotePlayer(id, data);
    }
}


function updateRemoteEgg(id, data) {
    const egg = eggs[id];
    if (!egg) return;

    // Update target position and rotation
    egg.position.set(data.x, 0, data.z);
    egg.rotation = data.rotation;

    // Interpolate position and rotation
    egg.model.position.lerp(egg.position, 0.1); // Smooth position update
    egg.model.rotation.y = THREE.MathUtils.lerp(egg.model.rotation.y, egg.rotation, 0.1); // Smooth rotation update

}

function createRemoteEgg(id, data) {
    if (eggs[id] || loadingEggs.has(id)) {
        console.warn(`Skipping creation for egg ${id}. Already exists or is loading.`);
        return;
    }

    loadingEggs.add(id); // Mark as loading

    const loader = new GLTFLoader();
    loader.load(
        eggPath,
        (gltf) => {
            const remoteModel = gltf.scene;
            remoteModel.position.set(data.x, 0, data.z);
            remoteModel.rotation.y = data.rotation;
            remoteModel.castShadow = true;

            eggs[id] = {
                model: remoteModel,
                position: new THREE.Vector3(data.x, 0, data.z),
                rotation: data.rotation,
                ownerId: data.ownerId || null, // Track egg owner
            };

            scene.add(remoteModel);
            loadingEggs.delete(id);
        },
        undefined,
        (error) => {
            console.error(`Error loading model for egg ${id}:`, error);
            loadingEggs.delete(id);
        }
    );
}



function updateRemotePlayer(id, data) {
    const player = players[id];
    if (!player) return;

    // Update target position and rotation
    player.position.set(data.x, 0, data.z);
    player.rotation = data.rotation;

    // Interpolate position and rotation
    player.model.position.lerp(player.position, 0.1); // Smooth position update
    player.model.rotation.y = THREE.MathUtils.lerp(player.model.rotation.y, player.rotation, 0.1); // Smooth rotation update

    // Detect movement
    const distanceMoved = player.position.distanceTo(player.model.position); // Measure distance moved
    const isMoving = distanceMoved > 0.01; // Threshold for motion detection

    // Determine action based on movement
    const action = isMoving ? (distanceMoved > 0.5 ? 'run' : 'walk') : 'idle'; // "run" if moving fast, "walk" if slow

    // Update animation state only if changed
    if (player.currentAction !== action) {
        if (player.actions[player.currentAction]) {
            player.actions[player.currentAction].fadeOut(0.5); // Smoothly fade out current animation
        }
        if (player.actions[action]) {
            player.actions[action].reset().fadeIn(0.5).play(); // Smoothly fade in new animation
        }
        player.currentAction = action; // Update current action state
    }
}


function createRemotePlayer(id, data) {
    if (players[id] || loadingPlayers.has(id)) {
        console.warn(`Skipping creation for player ${id}. Already exists or is loading.`);
        return;
    }

    loadingPlayers.add(id); // Mark as loading

    const loader = new GLTFLoader();
    loader.load(
        modelPath,
        (gltf) => {
            const remoteModel = gltf.scene;
            remoteModel.position.set(data.x, 0, data.z);
            remoteModel.rotation.y = data.rotation;
            remoteModel.castShadow = true;

            const remoteMixer = new THREE.AnimationMixer(remoteModel);
            const remoteActions = {};
            gltf.animations.forEach((clip) => {
                remoteActions[clip.name] = remoteMixer.clipAction(clip);
            });

            // Start with the idle animation
            if (remoteActions['idle']) {
                remoteActions['idle'].play();
            }

            players[id] = {
                model: remoteModel,
                mixer: remoteMixer,
                actions: remoteActions,
                position: new THREE.Vector3(data.x, 0, data.z),
                rotation: data.rotation,
                currentAction: 'idle', // Track current animation
            };

            scene.add(remoteModel);
            loadingPlayers.delete(id); // Remove from loading set
        },
        undefined,
        (error) => {
            console.error(`Error loading model for player ${id}:`, error);
            loadingPlayers.delete(id); // Ensure the flag is cleared even on error
        }
    );
}


function updatePlayers(playersData) {
    Object.keys(playersData).forEach((id) => {
        if (id !== myId) {
            addOrUpdatePlayer(id, playersData[id]);
        }
    });

    Object.keys(players).forEach((id) => {
        if (!playersData[id]) {
            removeRemotePlayer(id);
        }
    });
}

function updateEggs(eggsData) {
    Object.keys(eggsData).forEach((id) => {
        addOrUpdateEgg(id, eggsData[id]); // Add or update each egg
    });

    Object.keys(eggs).forEach((id) => {
        if (!eggsData[id]) {
            removeRemoteEgg(id); // Remove eggs that are no longer in the update
        }
    });
}



function removeRemoteEgg(id) {
    if (eggs[id]) {
        scene.remove(eggs[id].model); // Remove model from scene
        delete eggs[id]; // Delete from tracking object
    }
}


function removeRemotePlayer(id) {
    if (players[id]) {
        scene.remove(players[id].model);
        delete players[id];
    }
    removeRemoteEgg(id);
}

function onKeyDown(event) {

    if (event.key in keyStates) {
        keyStates[event.key] = true; // Mark key as pressed
        handleKeyStates(); // Reevaluate key states
    }

    // Handle 'E' key for egg creation
    if (event.key === 'e' && canPlaceEgg) {
        placeEgg(); // Create the egg
    }
}

function onKeyUp(event) {
    if (event.key in keyStates) {
        keyStates[event.key] = false; // Mark key as released
        handleKeyStates(); // Reevaluate key states
    }
}

function handleKeyStates() {
    // Detect movement keys
    moveForward = keyStates['w'];
    moveBackward = keyStates['s'];
    rotateLeft = keyStates['a'];
    rotateRight = keyStates['d'];

    // Determine running state: Shift modifies W or S behavior
    isRunning = keyStates['Shift'] && (moveForward || moveBackward);

    // Explicitly check key combinations for animation state
    if (moveForward && isRunning) {
        setLocalAction('run'); // Running forward
    } else if (moveForward) {
        setLocalAction('walk'); // Walking forward
    } else if (moveBackward) {
        setLocalAction('walk'); // Walking backward (no running backward)
    } else {
        setLocalAction('idle'); // Default to idle if no movement keys are active
    }

    // Handle rotation (independent of W/S/Shift states)
    if (rotateLeft) {
        rotateLocalCharacter(-1, clock.getDelta());
    } else if (rotateRight) {
        rotateLocalCharacter(1, clock.getDelta());
    }
}

function setLocalAction(name) {
    if (currentAction !== name) {
        if (localActions[currentAction]) {
            localActions[currentAction].fadeOut(0.5); // Smoothly transition out
        }
        if (localActions[name]) {
            localActions[name].reset().fadeIn(0.5).play(); // Smoothly transition in
        }
        currentAction = name; // Update current action
    }
}

function moveLocalCharacter(direction, delta) {
    const speed = isRunning ? runSpeed : walkSpeed; // Use run speed if running
    const forward = new THREE.Vector3(0, 0, direction);
    forward.applyQuaternion(localModel.quaternion);
    localModel.position.add(forward.multiplyScalar(speed * delta));
    socket.emit('move', {
        x: localModel.position.x,
        z: localModel.position.z,
        rotation: localModel.rotation.y,
        action: currentAction,
    });
}

function rotateLocalCharacter(direction, delta) {
    const rotationSpeed = isRunning ? rotateSpeed * 1.2 : rotateSpeed; // Faster rotation when running
    localModel.rotation.y += direction * rotationSpeed * delta;
    socket.emit('move', {
        x: localModel.position.x,
        z: localModel.position.z,
        rotation: localModel.rotation.y,
        action: currentAction,
    });
}


function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    // Update animations
    if (localMixer) localMixer.update(delta);

    // Handle local player movement
    if (localModel) {
        if (moveForward) moveLocalCharacter(1, delta);
        if (moveBackward) moveLocalCharacter(-1, delta);
        if (rotateLeft) rotateLocalCharacter(1, delta);
        if (rotateRight) rotateLocalCharacter(-1, delta);

        // Update camera position dynamically
        const cameraOffset = new THREE.Vector3(0, 2, -5); // Offset relative to the model
        cameraOffset.applyQuaternion(localModel.quaternion); // Rotate offset by model's rotation
        camera.position.copy(localModel.position.clone().add(cameraOffset)); // Add offset to model position
        camera.lookAt(localModel.position.clone().add(new THREE.Vector3(0, 1, 0))); // Look slightly above the model
    }

    // Update remote players
    Object.values(players).forEach((player) => {
        player.mixer.update(delta);
    });

    renderer.render(scene, camera);
}


function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function isEqual(obj1, obj2) {
    if (obj1 === obj2) return true;
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 === null || obj2 === null) return false;

    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);

    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
        if (!keys2.includes(key) || !isEqual(obj1[key], obj2[key])) return false;
    }

    return true;
}

function areAllEqual(objects) {
    if (objects.length < 2) return true; // Nothing to compare

    const firstObject = objects[0];
    for (let i = 1; i < objects.length; i++) {
        if (!isEqual(firstObject, objects[i])) {
            return false;
        }
    }

    return true;
}

function getRandomSpawnPoint() {
    const x = (Math.random() - 0.5) * 50; // Random x between -25 and 25
    const z = (Math.random() - 0.5) * 50; // Random z between -25 and 25
    const rotation = Math.random() * Math.PI * 2; // Random rotation between 0 and 2π
    return { x, z, rotation };
}

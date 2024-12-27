import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { io } from 'https://cdn.socket.io/4.4.1/socket.io.esm.min.js';
import SimplexNoise from 'https://cdn.jsdelivr.net/npm/simplex-noise@3.0.0/dist/esm/simplex-noise.min.js';

let modelPath;

if (window.location.pathname.includes('/public/')) {
    modelPath = '/public/Xbot.glb';
} else {
    modelPath = '/Xbot.glb';
}

console.log(`Model Path: ${modelPath}`); // For debugging purposes

const socket = io('https://full-canary-chokeberry.glitch.me/');

const simplex = new SimplexNoise();

// Store the listener globally for later use
let scene, camera, renderer, clock, listener;
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
    r: false, // microphone broadcast toggling
};

window.listener = listener; // Optional: Attach to window for global access

let localStream = null;          // MediaStream from user's microphone
let workletNode = null;          // AudioWorkletNode for capturing audio
const remoteAudioStreams = {};   // Map to keep track of remote audio streams by ID

let mediaStreamSource = null;    // MediaStreamSource from the microphone
let processor = null;            // ScriptProcessorNode for capturing audio data

const walkSpeed = 2;
const runSpeed = 5; // Higher speed for running
const rotateSpeed = Math.PI / 2;
const loadingPlayers = new Set(); // Track players being loaded
const players = {};
let myId = null;

// Mountainscape variables
const terrainSize = 100;
const terrainSegments = 100;

init();
animate();

function init() {
    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x454545);
    scene.fog = new THREE.Fog(0x454545, 10, 50);

    // Camera
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100);
    camera.position.set(0, 2, -5);

    // Audio listener
    listener = new THREE.AudioListener();
    camera.add(listener);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.xr.enabled = true;         // Enable WebXR
    document.body.appendChild(renderer.domElement);

    // Add VR Button (including hand-tracking, as in your original)
    const sessionInit = {
        requiredFeatures: ['hand-tracking']
    };
    document.body.appendChild(VRButton.createButton(renderer, sessionInit));

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
    hemiLight.position.set(0, 50, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(10, 50, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024); // Reduced resolution
    scene.add(dirLight);

    // Simple ground placeholder
    const ground = new THREE.Mesh();
    ground.receiveShadow = true;
    scene.add(ground);

    // === Initialize AudioContext Upon User Interaction ===
    document.addEventListener('click', handleUserInteraction, { once: true });
    document.addEventListener('keydown', handleUserInteraction, { once: true });

    // Clock
    clock = new THREE.Clock();

    // Generate your stylized terrain or lines
    generateTerrain();

    // Load Local (own) Model
    loadLocalModel();

    // Key Events (desktop WASD)
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Window resize
    window.addEventListener('resize', onWindowResize);

    // Socket setup
    setupSocketEvents();
}

// Load local player model/animations
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
                action.loop = THREE.LoopRepeat; // Ensure the animation loops
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

// Set up Socket.io events
function setupSocketEvents() {
    socket.on('init', (data) => {
        console.log('Init data:', data);
        myId = data.id;
        updatePlayers(data.players);
    });

    socket.on('state_update_all', (data) => {
        updatePlayers(data);
        lastState = { ...data };
    });

    socket.on('new_player', (data) => {
        console.log('New Player data:', data);
        addOrUpdatePlayer(data.id, data);
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
    });

    // Handle 'start_audio' from other clients
    socket.on('start_audio', (id) => {
        console.log(`User ${id} started broadcasting audio.`);
        addRemoteAudioStream(id);
    });

    // Handle 'stop_audio' from other clients
    socket.on('stop_audio', (id) => {
        console.log(`User ${id} stopped broadcasting audio.`);
        removeRemoteAudioStream(id);
    });

    // Handle 'audio_stream' events from other clients
    socket.on('audio_stream', (data) => {
        const { id, audio } = data;
        receiveAudioStream(id, audio);
    });
}

// Desktop key down
function onKeyDown(event) {
    if (event.key in keyStates) {
        if (!keyStates[event.key]) {
            keyStates[event.key] = true;
            if (event.key === 'r') {
                startBroadcast(); // Start broadcasting audio
            }
            handleKeyStates();
        }
    }
}

// Desktop key up
function onKeyUp(event) {
    if (event.key in keyStates) {
        keyStates[event.key] = false;
        if (event.key === 'r') {
            stopBroadcast(); // Stop broadcasting audio
        }
        handleKeyStates();
    }
}

// Decide which movement state the desktop user is in
function handleKeyStates() {
    // Detect movement keys
    moveForward = keyStates['w'];
    moveBackward = keyStates['s'];
    rotateLeft = keyStates['a'];
    rotateRight = keyStates['d'];

    // Determine running state: Shift modifies W or S
    isRunning = keyStates['Shift'] && (moveForward || moveBackward);

    // Determine movement direction
    let movementDirection = null; // 'forward' or 'backward'
    let action = 'idle'; // Default action

    if (moveForward && isRunning) {
        action = 'run';
        movementDirection = 'forward';
    } else if (moveForward) {
        action = 'walk';
        movementDirection = 'forward';
    } else if (moveBackward && isRunning) {
        action = 'run';
        movementDirection = 'backward';
    } else if (moveBackward) {
        action = 'walk';
        movementDirection = 'backward';
    } else {
        action = 'idle';
    }

    if (action !== 'idle') {
        setLocalAction(action, movementDirection);
    } else {
        setLocalAction('idle');
    }

    // Rotation states handled in animate()
}

// Change local animation with crossfade
function setLocalAction(name, direction = 'forward') {
    if (currentAction !== name) {
        // Fade out the current action
        if (localActions[currentAction]) {
            localActions[currentAction].fadeOut(0.5);
        }
        // Fade in the new action
        if (localActions[name]) {
            localActions[name].reset().fadeIn(0.5).play();

            // For walking/running forward/backward
            if (name === 'walk' || name === 'run') {
                localActions[name].timeScale = direction === 'forward' ? 1 : -1;
                if (direction === 'backward') {
                    // Start from the end if playing backward
                    localActions[name].time = localActions[name].getClip().duration;
                } else {
                    localActions[name].time = 0;
                }
            } else {
                localActions[name].timeScale = 1;
            }
        }
        currentAction = name;
    } else {
        // If the action is the same, just update the timeScale if it's walk/run
        if (name === 'walk' || name === 'run') {
            localActions[name].timeScale = direction === 'forward' ? 1 : -1;
            if (direction === 'backward') {
                // Adjust the time to play backward smoothly
                localActions[name].time = localActions[name].getClip().duration - localActions[name].time;
            }
        }
    }
}

// Helper for desktop: move forward/back
function moveLocalCharacter(direction, delta) {
    const speed = isRunning ? runSpeed : walkSpeed; // run or walk
    const forward = new THREE.Vector3(0, 0, direction);
    forward.applyQuaternion(localModel.quaternion);
    localModel.position.add(forward.multiplyScalar(speed * delta));

    // Emit movement
    socket.emit('move', {
        x: localModel.position.x,
        z: localModel.position.z,
        rotation: localModel.rotation.y,
        action: currentAction,
    });
}

// Helper for desktop: rotate left/right
function rotateLocalCharacter(direction, delta) {
    const rotationSpeed = isRunning ? rotateSpeed * 1.2 : rotateSpeed; // faster spin if running
    localModel.rotation.y += direction * rotationSpeed * delta;

    // Emit movement
    socket.emit('move', {
        x: localModel.position.x,
        z: localModel.position.z,
        rotation: localModel.rotation.y,
        action: currentAction,
    });
}

// === VR Movement Logic ===
// Poll the left thumbstick for forward/strafe movement, using the headset orientation
function handleVRMovement(delta) {
    const session = renderer.xr.getSession();
    if (!session || !localModel) return;

    // We can do multiple inputSources but typically each controller is one source
    for (const source of session.inputSources) {
        if (!source.gamepad) continue;
        // Let's use the left controller for movement
        if (source.handedness === 'left') {
            const { axes } = source.gamepad;
            // Typically: axes[0] = X (left-right), axes[1] = Y (up-down for thumbstick)
            const strafe = axes[0];
            const forwardVal = -axes[1]; // Negative so that pushing up is forward

            // Simple deadzone check to avoid drift
            const deadZone = 0.15;
            const moveX = Math.abs(strafe) > deadZone ? strafe : 0;
            const moveZ = Math.abs(forwardVal) > deadZone ? forwardVal : 0;

            // Decide if we "walk" or "idle" based on magnitude
            const magnitude = Math.sqrt(moveX * moveX + moveZ * moveZ);
            const threshold = 0.7; // example threshold for "running"
            if (magnitude > 0.01) {
                if (magnitude > threshold) {
                    setLocalAction('run');
                } else {
                    setLocalAction('walk');
                }
            } else {
                setLocalAction('idle');
            }

            // You can incorporate run logic if you have a button for "run"
            // e.g., isRunning = source.gamepad.buttons[1].pressed

            const speed = isRunning ? runSpeed : walkSpeed;

            // The VR "forward" direction is from the camera's orientation
            const cameraDirection = new THREE.Vector3();
            camera.getWorldDirection(cameraDirection);
            cameraDirection.y = 0; // flatten so we don't tilt up/down
            cameraDirection.normalize();

            // The side vector is perpendicular to camera direction
            const sideVector = new THREE.Vector3();
            sideVector.crossVectors(new THREE.Vector3(0, 1, 0), cameraDirection).normalize();

            // Combine them
            const movement = new THREE.Vector3();
            movement.addScaledVector(cameraDirection, moveZ * speed * delta);
            movement.addScaledVector(sideVector, moveX * speed * delta);

            // Move localModel
            localModel.position.add(movement);

            // Because we're in VR, the camera is controlled by the headset.
            // We can keep the localModel and camera in sync if desired:
            // For example, place camera 2m above localModel’s position
            const cameraOffset = new THREE.Vector3(0, 2, 0);
            camera.position.copy(localModel.position).add(cameraOffset);

            // Broadcast position & orientation
            socket.emit('move', {
                x: localModel.position.x,
                z: localModel.position.z,
                // We can set rotation to camera yaw if you want the avatar
                // to match the headset's facing direction. This is optional:
                rotation: getCameraYaw(),
                action: currentAction,
            });
        }
    }
}

// Grab the camera's yaw angle so avatar can rotate to match
function getCameraYaw() {
    const euler = new THREE.Euler();
    euler.setFromQuaternion(camera.quaternion, 'YXZ');
    return euler.y;
}

// Main loop
function animate() {
    renderer.setAnimationLoop(() => {
        const delta = clock.getDelta();

        // Update local animations
        if (localMixer) localMixer.update(delta);

        // If we’re in VR, use VR movement. Otherwise, desktop WASD
        if (renderer.xr.isPresenting) {
            handleVRMovement(delta);
        } else if (localModel) {
            // Desktop movement
            if (moveForward) moveLocalCharacter(1, delta);
            if (moveBackward) moveLocalCharacter(-1, delta);
            if (rotateLeft) rotateLocalCharacter(1, delta);
            if (rotateRight) rotateLocalCharacter(-1, delta);

            // Keep the camera behind/above localModel, desktop style
            const cameraOffset = new THREE.Vector3(0, 2, -5);
            cameraOffset.applyQuaternion(localModel.quaternion);
            camera.position.copy(localModel.position.clone().add(cameraOffset));
            camera.lookAt(localModel.position.clone().add(new THREE.Vector3(0, 1, 0)));
        }

        // Update remote player animations
        Object.values(players).forEach((player) => {
            player.mixer.update(delta);
        });

        renderer.render(scene, camera);
    });
}

// Generate terrain / stylized lines
function generateTerrain() {
    const size = terrainSize;
    const segments = terrainSegments;
    const halfSize = size / 2;
    const segmentSize = size / segments;

    const distanceRanges = [
        { min: 0, max: size * 0.2, pointSize: 0.02, lineOpacity: 0.0 },
        { min: size * 0.2, max: size * 0.4, pointSize: 0.015, lineOpacity: 0.1 },
        { min: size * 0.4, max: size * 0.5, pointSize: 0.012, lineOpacity: 0.2 },
        { min: size * 0.5, max: size * 0.6, pointSize: 0.01, lineOpacity: 0.4 },
        { min: size * 0.6, max: size * 0.7, pointSize: 0.008, lineOpacity: 0.6 },
        { min: size * 0.8, max: size * 0.5, pointSize: 0.005, lineOpacity: 1.0 },
    ];

    const pointsByRange = [];
    const linesByRange = [];
    for (let i = 0; i < distanceRanges.length; i++) {
        pointsByRange.push([]);
        linesByRange.push([]);
    }

    const vertexIndices = [];
    for (let i = 0; i <= segments; i++) {
        vertexIndices[i] = [];
        for (let j = 0; j <= segments; j++) {
            const x = i * segmentSize - halfSize;
            const z = j * segmentSize - halfSize;

            const distance = Math.sqrt(x * x + z * z);
            let y = 0;

            if (distance <= size * 0.5) {
                if (distance > size * 0.3) {
                    y = Math.pow((distance - size * 0.3) / (halfSize - size * 0.3), 1.5) * 2 * (Math.random() * 0.7 + 0.5);
                }

                let rangeIndex = distanceRanges.length - 1;
                for (let k = 0; k < distanceRanges.length; k++) {
                    if (distance >= distanceRanges[k].min && distance < distanceRanges[k].max) {
                        rangeIndex = k;
                        break;
                    }
                }

                pointsByRange[rangeIndex].push(x, y, z);
                vertexIndices[i][j] = { index: (pointsByRange[rangeIndex].length / 3) - 1, rangeIndex };
            } else {
                vertexIndices[i][j] = undefined;
            }
        }
    }

    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < segments; j++) {
            const currentVertex = vertexIndices[i][j];
            const rightVertex = vertexIndices[i][j + 1];
            const bottomVertex = vertexIndices[i + 1] ? vertexIndices[i + 1][j] : undefined;

            if (currentVertex !== undefined) {
                const x0 = pointsByRange[currentVertex.rangeIndex][currentVertex.index * 3];
                const y0 = pointsByRange[currentVertex.rangeIndex][currentVertex.index * 3 + 1];
                const z0 = pointsByRange[currentVertex.rangeIndex][currentVertex.index * 3 + 2];

                if (rightVertex !== undefined && currentVertex.rangeIndex === rightVertex.rangeIndex) {
                    const x1 = pointsByRange[rightVertex.rangeIndex][rightVertex.index * 3];
                    const y1 = pointsByRange[rightVertex.rangeIndex][rightVertex.index * 3 + 1];
                    const z1 = pointsByRange[rightVertex.rangeIndex][rightVertex.index * 3 + 2];

                    linesByRange[currentVertex.rangeIndex].push(
                        x0, y0, z0,
                        x1, y1, z1
                    );
                }
                if (bottomVertex !== undefined && currentVertex.rangeIndex === bottomVertex.rangeIndex) {
                    const x2 = pointsByRange[bottomVertex.rangeIndex][bottomVertex.index * 3];
                    const y2 = pointsByRange[bottomVertex.rangeIndex][bottomVertex.index * 3 + 1];
                    const z2 = pointsByRange[bottomVertex.rangeIndex][bottomVertex.index * 3 + 2];

                    linesByRange[currentVertex.rangeIndex].push(
                        x0, y0, z0,
                        x2, y2, z2
                    );
                }
            }
        }
    }

    for (let k = 0; k < distanceRanges.length; k++) {
        const vertices = pointsByRange[k];
        if (vertices.length > 0) {
            const terrainGeometry = new THREE.BufferGeometry();
            terrainGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

            const terrainMaterial = new THREE.PointsMaterial({
                color: 0xffffff,
                size: distanceRanges[k].pointSize,
                transparent: true,
                opacity: 1.0
            });

            const terrainMesh = new THREE.Points(terrainGeometry, terrainMaterial);
            scene.add(terrainMesh);
        }

        const lineVertices = linesByRange[k];
        if (lineVertices.length > 0 && distanceRanges[k].lineOpacity > 0) {
            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lineVertices, 3));

            const lineMaterial = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: distanceRanges[k].lineOpacity,
                linewidth: 1
            });

            const terrainLines = new THREE.LineSegments(lineGeometry, lineMaterial);
            scene.add(terrainLines);
        }
    }
}

// Create or update a remote player
function addOrUpdatePlayer(id, data) {
    if (!players[id]) {
        createRemotePlayer(id, data);
    } else {
        updateRemotePlayer(id, data);
    }
}

// Create a remote player's model
function createRemotePlayer(id, data) {
    if (players[id] || loadingPlayers.has(id)) {
        console.warn(`Skipping creation for player ${id}. Already exists or is loading.`);
        return;
    }

    loadingPlayers.add(id);

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

            // Start idle
            if (remoteActions['idle']) {
                remoteActions['idle'].play();
            }

            players[id] = {
                model: remoteModel,
                mixer: remoteMixer,
                actions: remoteActions,
                position: new THREE.Vector3(data.x, 0, data.z),
                rotation: data.rotation,
                currentAction: 'idle',
                initialized: true,
            };

            scene.add(remoteModel);
            loadingPlayers.delete(id);
        },
        undefined,
        (error) => {
            console.error(`Error loading model for player ${id}:`, error);
            loadingPlayers.delete(id);
        }
    );
}

// Update remote player's position/rotation
function updateRemotePlayer(id, data) {
    const player = players[id];
    if (!player) return;

    if (!player.initialized) {
        player.model.position.set(data.x, 0, data.z);
        player.model.rotation.y = data.rotation;
        player.initialized = true;
        return;
    }

    player.position.set(data.x, 0, data.z);
    player.rotation = data.rotation;

    // Interpolate for smooth movement
    player.model.position.lerp(player.position, 0.1);
    player.model.rotation.y = THREE.MathUtils.lerp(player.model.rotation.y, player.rotation, 0.1);

    if (remoteAudioStreams[id]) {
        remoteAudioStreams[id].positionalAudio.position.copy(player.model.position);
    }

    // Determine movement
    const distanceMoved = player.position.distanceTo(player.model.position);
    const isMoving = distanceMoved > 0.01;
    const movementDirection = player.position.clone().sub(player.model.position).normalize();
    const forwardDirection = new THREE.Vector3(0, 0, 1).applyQuaternion(player.model.quaternion);
    const isMovingForward = movementDirection.dot(forwardDirection) > 0;

    let action = 'idle';
    if (isMoving) {
        action = distanceMoved > 0.5 ? 'run' : 'walk';
    }

    if (player.currentAction !== action) {
        if (player.actions[player.currentAction]) {
            player.actions[player.currentAction].fadeOut(0.5);
        }
        if (player.actions[action]) {
            player.actions[action].reset().fadeIn(0.5).play();
            if (action === 'walk' || action === 'run') {
                player.actions[action].timeScale = isMovingForward ? 1 : -1;
            }
        }
        player.currentAction = action;
    }
}

// Remove a remote player
function removeRemotePlayer(id) {
    if (players[id]) {
        scene.remove(players[id].model);
        delete players[id];
    }
    removeRemoteAudioStream(id);
}

// Generic function: update all players
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

// Audio

function handleUserInteraction() {
    if (listener.context.state === 'suspended') {
        listener.context.resume().then(() => {
            console.log('AudioContext resumed on user interaction.');
        }).catch((err) => {
            console.error('Error resuming AudioContext:', err);
        });
    }
    document.removeEventListener('click', handleUserInteraction);
    document.removeEventListener('keydown', handleUserInteraction);
}

async function startBroadcast() {
    if (localStream) return;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        mediaStreamSource = listener.context.createMediaStreamSource(localStream);

        processor = listener.context.createScriptProcessor(4096, 1, 1);
        mediaStreamSource.connect(processor);
        processor.connect(listener.context.destination);

        processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const buffer = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                buffer[i] = inputData[i] * 32767;
            }
            socket.emit('audio_stream', buffer.buffer);
        };

        socket.emit('start_audio');
        console.log('Started broadcasting audio.');
    } catch (err) {
        console.error('Error accessing microphone:', err);
    }
}

function stopBroadcast() {
    if (!localStream) return;

    if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
        processor = null;
    }
    if (mediaStreamSource) {
        mediaStreamSource.disconnect();
        mediaStreamSource = null;
    }

    localStream.getTracks().forEach(track => track.stop());
    localStream = null;

    socket.emit('stop_audio');
    console.log('Stopped broadcasting audio.');
}

// Positional audio for remote players
function addRemoteAudioStream(id) {
    if (!listener.context) {
        console.warn('AudioContext not initialized. Cannot add remote audio stream.');
        return;
    }
    const player = players[id];
    if (!player) {
        console.warn(`Player with ID ${id} not found.`);
        return;
    }
    if (remoteAudioStreams[id]) return;

    const positionalAudio = new THREE.PositionalAudio(listener);
    positionalAudio.setRefDistance(20);
    positionalAudio.setVolume(1.0);
    player.model.add(positionalAudio);
    positionalAudio.play();

    remoteAudioStreams[id] = {
        positionalAudio,
    };
}

function removeRemoteAudioStream(id) {
    const remoteAudio = remoteAudioStreams[id];
    if (remoteAudio) {
        remoteAudio.positionalAudio.stop();
        remoteAudio.positionalAudio.disconnect();
        remoteAudio.positionalAudio = null;
        delete remoteAudioStreams[id];
    }
}

function receiveAudioStream(id, audioBuffer) {
    if (!listener.context) {
        console.warn('AudioContext not initialized. Cannot receive audio stream.');
        return;
    }

    const remoteAudio = remoteAudioStreams[id];
    if (!remoteAudio) {
        console.warn(`Received audio data from ${id} before audio stream started.`);
        return;
    }

    const int16 = new Int16Array(audioBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32767;
    }

    const buffer = listener.context.createBuffer(1, float32.length, listener.context.sampleRate);
    buffer.copyToChannel(float32, 0, 0);

    const bufferSource = listener.context.createBufferSource();
    bufferSource.buffer = buffer;
    bufferSource.connect(remoteAudio.positionalAudio.gain);
    bufferSource.start();

    bufferSource.onended = () => {
        bufferSource.disconnect();
    };
}

// Utility to randomize spawn
function getRandomSpawnPoint() {
    const x = (Math.random() - 0.5) * 50; 
    const z = (Math.random() - 0.5) * 50; 
    const rotation = Math.random() * Math.PI * 2; 
    return { x, z, rotation };
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

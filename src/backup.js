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
    r: false, // Added 'r' key
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
let terrainPoints;
let terrainMaterial;
let terrainMesh;

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

    
    listener = new THREE.AudioListener();
    camera.add(listener);


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
    const ground = new THREE.Mesh(); ground.receiveShadow = true; // Enable ground to receive shadows
    scene.add(ground);

    // Add VR Button with hand-tracking
    const sessionInit = {
        requiredFeatures: ['hand-tracking']
    };

    document.body.appendChild(VRButton.createButton(renderer, sessionInit));
    // === Initialize AudioContext Upon User Interaction ===
    document.addEventListener('click', handleUserInteraction, { once: true });
    document.addEventListener('keydown', handleUserInteraction, { once: true });

    // Clock
    clock = new THREE.Clock();

    generateTerrain();


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

function addOrUpdatePlayer(id, data) {
    if (!players[id]) {
        // Create a new remote player
        createRemotePlayer(id, data);
    } else {
        // Update existing remote player
        updateRemotePlayer(id, data);
    }
}

function updateRemotePlayer(id, data) {
    const player = players[id];
    if (!player) return;

    if (!player.initialized) {
        // Directly set position and rotation on the first update
        player.model.position.set(data.x, 0, data.z);
        player.model.rotation.y = data.rotation;
        player.initialized = true; // Mark as initialized
        return; // No interpolation needed for the first update
    }

    // Update target position and rotation
    player.position.set(data.x, 0, data.z);
    player.rotation = data.rotation;

    // Interpolate position and rotation for smooth movement
    player.model.position.lerp(player.position, 0.1);
    player.model.rotation.y = THREE.MathUtils.lerp(player.model.rotation.y, player.rotation, 0.1);

    // Update the position of the remote player's audio if it exists
    if (remoteAudioStreams[id]) {
        remoteAudioStreams[id].positionalAudio.position.copy(player.model.position);
    }

    // Detect movement
    const distanceMoved = player.position.distanceTo(player.model.position); // Measure distance moved
    const isMoving = distanceMoved > 0.01; // Threshold for motion detection

    // Determine if moving forward or backward
    const movementDirection = player.position.clone().sub(player.model.position).normalize(); // Direction vector
    const forwardDirection = new THREE.Vector3(0, 0, 1).applyQuaternion(player.model.quaternion); // Player's forward vector
    const isMovingForward = movementDirection.dot(forwardDirection) > 0; // Dot product determines forward/backward

    // Determine action based on movement
    const action = isMoving ? (distanceMoved > 0.5 ? 'run' : 'walk') : 'idle'; // "run" if moving fast, "walk" if slow

    // Update animation state only if changed
    if (player.currentAction !== action) {
        if (player.actions[player.currentAction]) {
            player.actions[player.currentAction].fadeOut(0.5); // Smoothly fade out current animation
        }
        if (player.actions[action]) {
            player.actions[action].reset().fadeIn(0.5).play();

            // Adjust timeScale for walking animation based on direction
            if (action === 'walk' || action === 'run') {
                player.actions[action].timeScale = isMovingForward ? 1 : -1;
            }
        }
        player.currentAction = action; // Update current action state
    }
}



function generateTerrain() {    // First, define 'size' and related variables
    const size = terrainSize;
    const segments = terrainSegments;
    const halfSize = size / 2;
    const segmentSize = size / segments;

    // Configuration for distance ranges
    const distanceRanges = [
        { min: 0, max: size * 0.2, pointSize: 0.02, lineOpacity: 0.0 }, // Center: points only, no lines
        { min: size * 0.2, max: size * 0.4, pointSize: 0.015, lineOpacity: 0.1 },
        { min: size * 0.4, max: size * 0.5, pointSize: 0.012, lineOpacity: 0.2 },
        { min: size * 0.5, max: size * 0.6, pointSize: 0.01, lineOpacity: 0.4 },
        { min: size * 0.6, max: size * 0.7, pointSize: 0.008, lineOpacity: 0.6 },
        { min: size * 0.8, max: size * 0.5, pointSize: 0.005, lineOpacity: 1.0 }, // Edge: smallest points, most solid lines
    ];

    // Arrays to hold points and lines for each range
    const pointsByRange = [];
    const linesByRange = [];

    // Initialize arrays
    for (let i = 0; i < distanceRanges.length; i++) {
        pointsByRange.push([]);
        linesByRange.push([]);
    }

    const vertexIndices = []; // Map from grid indices to vertex indices

    // Generate vertices and assign them to distance ranges
    let totalVertices = 0;
    for (let i = 0; i <= segments; i++) {
        vertexIndices[i] = [];
        for (let j = 0; j <= segments; j++) {
            const x = i * segmentSize - halfSize;
            const z = j * segmentSize - halfSize;

            // Calculate distance from center
            const distance = Math.sqrt(x * x + z * z);
            let y = 0;

            // Circular boundary
            if (distance <= size * 0.5) {
                // Adjust height to form mountains at edges
                if (distance > size * 0.3) {
                    y = Math.pow((distance - size * 0.3) / (halfSize - size * 0.3), 1.5) * 2 * (Math.random() * 0.7 + 0.5);
                }

                // Find the appropriate distance range
                let rangeIndex = distanceRanges.length - 1;
                for (let k = 0; k < distanceRanges.length; k++) {
                    if (distance >= distanceRanges[k].min && distance < distanceRanges[k].max) {
                        rangeIndex = k;
                        break;
                    }
                }

                // Add vertex to the appropriate range
                pointsByRange[rangeIndex].push(x, y, z);
                // Store the vertex index relative to its range
                vertexIndices[i][j] = { index: (pointsByRange[rangeIndex].length / 3) - 1, rangeIndex };
                totalVertices++;
            } else {
                // Mark as undefined
                vertexIndices[i][j] = undefined;
            }
        }

    }

    // Generate lines for each range
    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < segments; j++) {
            const currentVertex = vertexIndices[i][j];
            const rightVertex = vertexIndices[i][j + 1];
            const bottomVertex = vertexIndices[i + 1] ? vertexIndices[i + 1][j] : undefined;

            if (currentVertex !== undefined) {
                const x0 = pointsByRange[currentVertex.rangeIndex][currentVertex.index * 3];
                const y0 = pointsByRange[currentVertex.rangeIndex][currentVertex.index * 3 + 1];
                const z0 = pointsByRange[currentVertex.rangeIndex][currentVertex.index * 3 + 2];

                // Line to the right neighbor
                if (rightVertex !== undefined && currentVertex.rangeIndex === rightVertex.rangeIndex) {
                    const x1 = pointsByRange[rightVertex.rangeIndex][rightVertex.index * 3];
                    const y1 = pointsByRange[rightVertex.rangeIndex][rightVertex.index * 3 + 1];
                    const z1 = pointsByRange[rightVertex.rangeIndex][rightVertex.index * 3 + 2];

                    linesByRange[currentVertex.rangeIndex].push(
                        x0, y0, z0,
                        x1, y1, z1
                    );
                }

                // Line to the bottom neighbor
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

    // Create Points and Lines for each range
    for (let k = 0; k < distanceRanges.length; k++) {
        // Points
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

        // Lines
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
            remoteModel.position.set(data.x, 0, data.z); // Set initial position
            remoteModel.rotation.y = data.rotation;     // Set initial rotation
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
                position: new THREE.Vector3(data.x, 0, data.z), // Set target position
                rotation: data.rotation,                      // Set target rotation
                currentAction: 'idle', // Track current animation
                initialized: true,     // Mark as initialized
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



function removeRemotePlayer(id) {
    if (players[id]) {
        scene.remove(players[id].model);
        delete players[id];
    }
    removeRemoteAudioStream(id);
}

function onKeyDown(event) {
    if (event.key in keyStates) {
        if (!keyStates[event.key]) { // Prevent repeat events
            keyStates[event.key] = true; // Mark key as pressed
            if (event.key === 'r') {
                startBroadcast(); // Start broadcasting audio
            }
            handleKeyStates(); // Handle movement and other keys
        }
    }
}

function onKeyUp(event) {
    if (event.key in keyStates) {
        keyStates[event.key] = false; // Mark key as released
        if (event.key === 'r') {
            stopBroadcast(); // Stop broadcasting audio
        }
        handleKeyStates(); // Handle movement and other keys
    }
}

// === Initialize AudioContext Upon User Interaction ===
function handleUserInteraction() {
    if (listener.context.state === 'suspended') {
        listener.context.resume().then(() => {
            console.log('AudioContext resumed on user interaction.');
        }).catch((err) => {
            console.error('Error resuming AudioContext:', err);
        });
    }
    // Remove event listeners after initialization to prevent redundant calls
    document.removeEventListener('click', handleUserInteraction);
    document.removeEventListener('keydown', handleUserInteraction);
}

function handleKeyStates() {
    // Detect movement keys
    moveForward = keyStates['w'];
    moveBackward = keyStates['s'];
    rotateLeft = keyStates['a'];
    rotateRight = keyStates['d'];

    // Determine running state: Shift modifies W or S behavior
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

    // Handle rotation (independent of W/S/Shift states)
    if (rotateLeft) {
        rotateLocalCharacter(-1, clock.getDelta());
    } else if (rotateRight) {
        rotateLocalCharacter(1, clock.getDelta());
    }
}


function setLocalAction(name, direction = 'forward') {
    if (currentAction !== name) {
        // Fade out the current action
        if (localActions[currentAction]) {
            localActions[currentAction].fadeOut(0.5);
        }

        // Fade in the new action
        if (localActions[name]) {
            localActions[name].reset().fadeIn(0.5).play();

            // Set timeScale based on direction
            if (name === 'walk' || name === 'run') {
                localActions[name].timeScale = direction === 'forward' ? 1 : -1;

                if (direction === 'backward') {
                    // Start the animation from the end if playing backward
                    localActions[name].time = localActions[name].getClip().duration;
                } else {
                    // Start from the beginning if playing forward
                    localActions[name].time = 0;
                }
            } else {
                // For other actions like 'idle', ensure timeScale is normal
                localActions[name].timeScale = 1;
            }
        }

        currentAction = name; // Update current action
    } else {
        // If the action is the same, just update the timeScale if it's 'walk' or 'run'
        if (name === 'walk' || name === 'run') {
            localActions[name].timeScale = direction === 'forward' ? 1 : -1;

            if (direction === 'backward') {
                // Adjust the time to play backward smoothly
                localActions[name].time = localActions[name].getClip().duration - localActions[name].time;
            }
        }
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

async function startBroadcast() {
    if (localStream) return; // Already broadcasting

    try {
        // Request microphone access
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

        // Create a MediaStreamSource from the microphone using Three.js's AudioContext
        mediaStreamSource = listener.context.createMediaStreamSource(localStream);

        // Create a ScriptProcessorNode to capture audio data
        processor = listener.context.createScriptProcessor(4096, 1, 1);

        // Connect the nodes
        mediaStreamSource.connect(processor);
        processor.connect(listener.context.destination);

        // Handle audio processing
        processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            // Convert Float32Array to Int16Array for transmission
            const buffer = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                buffer[i] = inputData[i] * 32767;
            }
            // Emit the audio data to the server
            socket.emit('audio_stream', buffer.buffer);
        };

        // Notify server to start broadcasting audio
        socket.emit('start_audio');

        console.log('Started broadcasting audio.');
    } catch (err) {
        console.error('Error accessing microphone:', err);
    }
}


function stopBroadcast() {
    if (!localStream) return; // Not broadcasting

    // Disconnect and close the audio nodes
    if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
        processor = null;
    }
    if (mediaStreamSource) {
        mediaStreamSource.disconnect();
        mediaStreamSource = null;
    }

    // Do not close audioContext here if it's used for remote audio
    // if (audioContext) {
    //     audioContext.close();
    //     audioContext = null;
    // }

    // Stop all tracks in the MediaStream
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;

    // Notify server to stop broadcasting audio
    socket.emit('stop_audio');

    console.log('Stopped broadcasting audio.');
}


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

    if (remoteAudioStreams[id]) return; // Already has an audio stream

    // Create a PositionalAudio object and attach it to the remote player
    const positionalAudio = new THREE.PositionalAudio(listener);
    positionalAudio.setRefDistance(20); // Adjust based on scene scale
    positionalAudio.setVolume(1.0); // Optional: Adjust volume as needed
    player.model.add(positionalAudio);
    positionalAudio.play();

    // Store the PositionalAudio object for later use
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
        remoteAudio.remoteStream = null;
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
        // Audio stream not started yet
        console.warn(`Received audio data from ${id} before audio stream started.`);
        return;
    }

    // Convert Int16Array back to Float32Array
    const int16 = new Int16Array(audioBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32767;
    }

    // Create an AudioBuffer and copy the float32 data
    const buffer = listener.context.createBuffer(1, float32.length, listener.context.sampleRate);
    buffer.copyToChannel(float32, 0, 0);

    // Create a BufferSource and set the buffer
    const bufferSource = listener.context.createBufferSource();
    bufferSource.buffer = buffer;
    bufferSource.connect(remoteAudio.positionalAudio.gain);
    bufferSource.start();

    // Optional: Clean up after playback
    bufferSource.onended = () => {
        bufferSource.disconnect();
    };
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

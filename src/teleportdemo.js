import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
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

// Scene objects
let scene, camera, renderer, clock, listener;
let localModel, localMixer;
let currentAction = 'idle';
let localActions = {};

// Desktop movement flags
let moveForward = false;
let moveBackward = false;
let rotateLeft = false;
let rotateRight = false;
let isRunning = false; // Shift modifies speed

// VR Teleport + ReferenceSpace
let baseReferenceSpace = null;
let floorMesh, markerMesh;
let INTERSECTION = null;
const tempMatrix = new THREE.Matrix4();

// Key states
const keyStates = {
    w: false,
    a: false,
    s: false,
    d: false,
    Shift: false,
    r: false, // microphone broadcast toggling
};

window.listener = listener; // Optional: Attach to window for global access

// Audio streaming
let localStream = null;
let workletNode = null;
let mediaStreamSource = null;
let processor = null;
const remoteAudioStreams = {};

// Player data
const loadingPlayers = new Set();
const players = {};
let myId = null;
let lastState = {};

// Movement speeds
const walkSpeed = 2;
const runSpeed = 5;
const rotateSpeed = Math.PI / 2; // Desktop rotate
const smoothTurnSpeed = 1.5;     // VR joystick rotate speed

// Terrain config
const terrainSize = 100;
const terrainSegments = 100;

init();
animate();

// ----------------------------------------------------
// Initialization
// ----------------------------------------------------

function init() {

    // Scene + camera
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x454545);
    scene.fog = new THREE.Fog(0x454545, 10, 50);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100);
    camera.position.set(0, 2, -5);

    // Listener for audio
    listener = new THREE.AudioListener();
    camera.add(listener);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.xr.enabled = true; // Enable WebXR
    document.body.appendChild(renderer.domElement);

    // VR Button
    const sessionInit = { requiredFeatures: ['hand-tracking'] };
    document.body.appendChild(VRButton.createButton(renderer, sessionInit));

    // Once the session starts, save a reference to the base XRReferenceSpace
    renderer.xr.addEventListener('sessionstart', () => {
        baseReferenceSpace = renderer.xr.getReferenceSpace();
    });

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
    hemiLight.position.set(0, 50, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(10, 50, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    scene.add(dirLight);

    // Floor for teleportation
    floorMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.25 })
    );
    floorMesh.name = 'teleport_floor';
    scene.add(floorMesh);

    // Teleport marker
    markerMesh = new THREE.Mesh(
        new THREE.CircleGeometry(0.25, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xbcbcbc })
    );
    markerMesh.visible = false;
    scene.add(markerMesh);

    // Set up VR controllers for teleporting + joystick rotation
    setupVRControllers();

    // Additional geometry (optional; e.g. mountains)
    generateTerrain();

    // Load local avatar
    loadLocalModel();

    // Desktop keyboard events
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Handle resizing
    window.addEventListener('resize', onWindowResize);

    // Setup Socket.io
    setupSocketEvents();

    // Clock
    clock = new THREE.Clock();

    // Initialize AudioContext upon user interaction
    document.addEventListener('click', handleUserInteraction, { once: true });
    document.addEventListener('keydown', handleUserInteraction, { once: true });
}

function setupVRControllers() {

    // Create two controllers + grips
    const controller1 = renderer.xr.getController(0);
    const controller2 = renderer.xr.getController(1);

    // Teleport events: "selectstart" / "selectend" for each
    function onSelectStart() {
        this.userData.isSelecting = true;
    }

    function onSelectEnd() {
        this.userData.isSelecting = false;
        if (!INTERSECTION) return;

        // We do BOTH:
        // 1) Move the XR ReferenceSpace (so the VR camera truly teleports).
        // 2) Move the localModel, so the server sees the correct new position.

        if (baseReferenceSpace) {
            // offset-based teleport for the camera
            const offsetPosition = {
                x: -INTERSECTION.x,
                y: -INTERSECTION.y,
                z: -INTERSECTION.z,
                w: 1
            };
            const offsetRotation = new THREE.Quaternion();
            const transform = new XRRigidTransform(offsetPosition, offsetRotation);
            const teleportSpaceOffset = baseReferenceSpace.getOffsetReferenceSpace(transform);
            renderer.xr.setReferenceSpace(teleportSpaceOffset);
        }

        // Also update localModel so it matches
        localModel.position.set(INTERSECTION.x, localModel.position.y, INTERSECTION.z);

        // Broadcast new position to server
        socket.emit('move', {
            x: localModel.position.x,
            z: localModel.position.z,
            rotation: localModel.rotation.y,
            action: currentAction,
        });
    }

    controller1.addEventListener('selectstart', onSelectStart);
    controller1.addEventListener('selectend', onSelectEnd);

    controller2.addEventListener('selectstart', onSelectStart);
    controller2.addEventListener('selectend', onSelectEnd);

    // Build a simple beam or ring to show which mode it's in
    controller1.addEventListener('connected', function (event) {
        this.add(buildControllerRay(event.data));
    });
    controller1.addEventListener('disconnected', function () {
        this.remove(this.children[0]);
    });

    controller2.addEventListener('connected', function (event) {
        this.add(buildControllerRay(event.data));
    });
    controller2.addEventListener('disconnected', function () {
        this.remove(this.children[0]);
    });

    scene.add(controller1);
    scene.add(controller2);

    // Now the "Grips"
    const controllerModelFactory = new XRControllerModelFactory();
    const controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    const controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);
}

// Build the controller ray (visual pointer)
function buildControllerRay(data) {
    let geometry, material;
    switch (data.targetRayMode) {
        case 'tracked-pointer':
            // A line to show the pointer
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3)
            );
            geometry.setAttribute(
                'color',
                new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0, 0, 0], 3)
            );
            material = new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending });
            return new THREE.Line(geometry, material);
        case 'gaze':
            // A ring
            geometry = new THREE.RingGeometry(0.02, 0.04, 32).translate(0, 0, -1);
            material = new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true });
            return new THREE.Mesh(geometry, material);
    }
}

// ----------------------------------------------------
// Desktop Keyboard Movement
// ----------------------------------------------------

function onKeyDown(event) {
    if (event.key in keyStates) {
        if (!keyStates[event.key]) {
            keyStates[event.key] = true;
            // 'r' = broadcast mic
            if (event.key === 'r') {
                startBroadcast();
            }
            handleKeyStates();
        }
    }
}

function onKeyUp(event) {
    if (event.key in keyStates) {
        keyStates[event.key] = false;
        if (event.key === 'r') {
            stopBroadcast();
        }
        handleKeyStates();
    }
}

function handleKeyStates() {
    // Map pressed keys to booleans
    moveForward = keyStates['w'];
    moveBackward = keyStates['s'];
    rotateLeft = keyStates['a'];
    rotateRight = keyStates['d'];
    isRunning = keyStates['Shift'] && (moveForward || moveBackward);

    // Decide local animation state
    let movementDirection = null;
    let action = 'idle';

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
}

// ----------------------------------------------------
// Desktop Movement Helpers
// ----------------------------------------------------

function moveLocalCharacter(direction, delta) {
    if (!localModel) return;
    const speed = isRunning ? runSpeed : walkSpeed;
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

function rotateLocalCharacter(direction, delta) {
    if (!localModel) return;
    const rotationSpeed = isRunning ? rotateSpeed * 1.2 : rotateSpeed;
    localModel.rotation.y += direction * rotationSpeed * delta;

    // Emit movement
    socket.emit('move', {
        x: localModel.position.x,
        z: localModel.position.z,
        rotation: localModel.rotation.y,
        action: currentAction,
    });
}

// ----------------------------------------------------
// VR Movement + Teleportation
// ----------------------------------------------------

function handleVRMovement(delta) {
    const session = renderer.xr.getSession();
    if (!session || !localModel) return;

    for (const source of session.inputSources) {
        if (!source.gamepad) continue;

        // 1) LEFT joystick for forward/strafe
        if (source.handedness === 'left') {
            const { axes, buttons } = source.gamepad;
            const strafe = axes[0];
            const forwardVal = -axes[1]; // push up is negative

            // Basic deadzone
            const deadZone = 0.15;
            const moveX = Math.abs(strafe) > deadZone ? strafe : 0;
            const moveZ = Math.abs(forwardVal) > deadZone ? forwardVal : 0;

            // Decide animation
            const magnitude = Math.sqrt(moveX * moveX + moveZ * moveZ);
            const threshold = 0.7;
            if (magnitude > 0.01) {
                if (magnitude > threshold) {
                    setLocalAction('run');
                } else {
                    setLocalAction('walk');
                }
            } else {
                setLocalAction('idle');
            }

            // You can incorporate run logic via a button check:
            // e.g. isRunning = buttons[1].pressed

            const speed = isRunning ? runSpeed : walkSpeed;

            // Move relative to camera direction
            const cameraDirection = new THREE.Vector3();
            camera.getWorldDirection(cameraDirection);
            cameraDirection.y = 0;
            cameraDirection.normalize();

            const sideVector = new THREE.Vector3();
            sideVector.crossVectors(new THREE.Vector3(0, 1, 0), cameraDirection).normalize();

            const movement = new THREE.Vector3();
            movement.addScaledVector(cameraDirection, moveZ * speed * delta);
            movement.addScaledVector(sideVector, moveX * speed * delta);

            // Move the local model
            localModel.position.add(movement);

            // Reposition camera above localModel if you want to keep them synced in VR
            const cameraOffset = new THREE.Vector3(0, 2, 0);
            camera.position.copy(localModel.position).add(cameraOffset);

            // Broadcast
            socket.emit('move', {
                x: localModel.position.x,
                z: localModel.position.z,
                rotation: getCameraYaw(),
                action: currentAction,
            });
        }

        // 2) RIGHT joystick for turning left/right
        if (source.handedness === 'right') {
            const { axes } = source.gamepad;
            // Typically axes[0] = X for horizontal turn
            const turn = axes[0];
            const deadZone = 0.2;
            if (Math.abs(turn) > deadZone) {
                // Smooth turn
                const turnDirection = Math.sign(turn); // +1 or -1
                const turnAmount = smoothTurnSpeed * turnDirection * delta;
                // Rotate localModel
                if (localModel) {
                    localModel.rotation.y -= turnAmount;
                }
                // If you want to broadcast orientation:
                socket.emit('move', {
                    x: localModel.position.x,
                    z: localModel.position.z,
                    rotation: localModel.rotation.y,
                    action: currentAction,
                });
            }
        }
    }
}

// Teleport intersection + marker
function checkTeleportIntersections() {
    INTERSECTION = null;
    markerMesh.visible = false;

    const session = renderer.xr.getSession();
    if (!session) return;

    // For both controllers, if user isSelecting, cast a ray
    session.inputSources.forEach((source) => {
        if (source && source.targetRayMode === 'tracked-pointer' && source.gamepad) {
            const handedness = source.handedness;
            // Grab the actual XRController object from Three.js
            const controller = handedness === 'left'
                ? renderer.xr.getController(0)
                : renderer.xr.getController(1);

            if (!controller.userData.isSelecting) return;

            // Build a ray
            tempMatrix.identity().extractRotation(controller.matrixWorld);
            const rayOrigin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
            const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);

            // Raycast
            const raycaster = new THREE.Raycaster(rayOrigin, rayDirection, 0, 100);
            const intersects = raycaster.intersectObject(floorMesh);
            if (intersects.length > 0) {
                INTERSECTION = intersects[0].point;
                markerMesh.position.copy(INTERSECTION);
                markerMesh.visible = true;
            }
        }
    });
}

// Grab the camera's yaw angle
function getCameraYaw() {
    const euler = new THREE.Euler();
    euler.setFromQuaternion(camera.quaternion, 'YXZ');
    return euler.y;
}

// ----------------------------------------------------
// Main Render Loop
// ----------------------------------------------------

function animate() {
    renderer.setAnimationLoop(() => {
        const delta = clock.getDelta();

        // 1) Update animations
        if (localMixer) localMixer.update(delta);

        // 2) VR logic or desktop logic
        if (renderer.xr.isPresenting) {
            // VR: Poll joystick + do teleport intersections
            handleVRMovement(delta);
            checkTeleportIntersections();
        } else if (localModel) {
            // Desktop movement
            if (moveForward) moveLocalCharacter(1, delta);
            if (moveBackward) moveLocalCharacter(-1, delta);
            if (rotateLeft) rotateLocalCharacter(1, delta);
            if (rotateRight) rotateLocalCharacter(-1, delta);

            // Keep camera behind localModel (desktop style)
            const cameraOffset = new THREE.Vector3(0, 2, -5);
            cameraOffset.applyQuaternion(localModel.quaternion);
            camera.position.copy(localModel.position.clone().add(cameraOffset));
            camera.lookAt(localModel.position.clone().add(new THREE.Vector3(0, 1, 0)));
        }

        // 3) Update remote players
        Object.values(players).forEach((player) => {
            player.mixer.update(delta);
        });

        // 4) Render
        renderer.render(scene, camera);
    });
}

// ----------------------------------------------------
// Avatar + Terrain
// ----------------------------------------------------

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

            localMixer = new THREE.AnimationMixer(localModel);
            gltf.animations.forEach((clip) => {
                const action = localMixer.clipAction(clip);
                action.loop = THREE.LoopRepeat;
                localActions[clip.name] = action;
                if (clip.name === 'idle') {
                    action.play();
                }
            });

            // Inform server
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
                    y = Math.pow(
                        (distance - size * 0.3) / (halfSize - size * 0.3),
                        1.5
                    ) * 2 * (Math.random() * 0.7 + 0.5);
                }

                let rangeIndex = distanceRanges.length - 1;
                for (let k = 0; k < distanceRanges.length; k++) {
                    if (distance >= distanceRanges[k].min && distance < distanceRanges[k].max) {
                        rangeIndex = k;
                        break;
                    }
                }
                pointsByRange[rangeIndex].push(x, y, z);
                vertexIndices[i][j] = {
                    index: pointsByRange[rangeIndex].length / 3 - 1,
                    rangeIndex,
                };
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
                const baseIndex = currentVertex.index * 3;
                const x0 = pointsByRange[currentVertex.rangeIndex][baseIndex];
                const y0 = pointsByRange[currentVertex.rangeIndex][baseIndex + 1];
                const z0 = pointsByRange[currentVertex.rangeIndex][baseIndex + 2];

                if (rightVertex !== undefined && currentVertex.rangeIndex === rightVertex.rangeIndex) {
                    const baseRight = rightVertex.index * 3;
                    const x1 = pointsByRange[rightVertex.rangeIndex][baseRight];
                    const y1 = pointsByRange[rightVertex.rangeIndex][baseRight + 1];
                    const z1 = pointsByRange[rightVertex.rangeIndex][baseRight + 2];
                    linesByRange[currentVertex.rangeIndex].push(x0, y0, z0, x1, y1, z1);
                }
                if (bottomVertex !== undefined && currentVertex.rangeIndex === bottomVertex.rangeIndex) {
                    const baseDown = bottomVertex.index * 3;
                    const x2 = pointsByRange[bottomVertex.rangeIndex][baseDown];
                    const y2 = pointsByRange[bottomVertex.rangeIndex][baseDown + 1];
                    const z2 = pointsByRange[bottomVertex.rangeIndex][baseDown + 2];
                    linesByRange[currentVertex.rangeIndex].push(x0, y0, z0, x2, y2, z2);
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
                opacity: 1.0,
            });

            const terrainPoints = new THREE.Points(terrainGeometry, terrainMaterial);
            scene.add(terrainPoints);
        }

        const lineVertices = linesByRange[k];
        if (lineVertices.length > 0 && distanceRanges[k].lineOpacity > 0) {
            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lineVertices, 3));

            const lineMaterial = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: distanceRanges[k].lineOpacity,
            });

            const terrainLines = new THREE.LineSegments(lineGeometry, lineMaterial);
            scene.add(terrainLines);
        }
    }
}

// ----------------------------------------------------
// Animation & Action Helpers
// ----------------------------------------------------

function setLocalAction(name, direction = 'forward') {
    if (currentAction !== name) {
        // Crossfade out old
        if (localActions[currentAction]) {
            localActions[currentAction].fadeOut(0.5);
        }
        // Fade in new
        if (localActions[name]) {
            localActions[name].reset().fadeIn(0.5).play();
            // timeScale for forward/back
            if (name === 'walk' || name === 'run') {
                localActions[name].timeScale = direction === 'forward' ? 1 : -1;
                if (direction === 'backward') {
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
        // If same action, just update timeScale if walk/run
        if (name === 'walk' || name === 'run') {
            localActions[name].timeScale = direction === 'forward' ? 1 : -1;
            if (direction === 'backward') {
                localActions[name].time = localActions[name].getClip().duration - localActions[name].time;
            }
        }
    }
}

// ----------------------------------------------------
// Socket.io Player Handling
// ----------------------------------------------------

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

    // Audio streaming from others
    socket.on('start_audio', (id) => {
        console.log(`User ${id} started broadcasting audio.`);
        addRemoteAudioStream(id);
    });
    socket.on('stop_audio', (id) => {
        console.log(`User ${id} stopped broadcasting audio.`);
        removeRemoteAudioStream(id);
    });
    socket.on('audio_stream', (data) => {
        const { id, audio } = data;
        receiveAudioStream(id, audio);
    });
}

function addOrUpdatePlayer(id, data) {
    if (!players[id]) {
        createRemotePlayer(id, data);
    } else {
        updateRemotePlayer(id, data);
    }
}

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

    // Smoothly move
    player.model.position.lerp(player.position, 0.1);
    player.model.rotation.y = THREE.MathUtils.lerp(player.model.rotation.y, player.rotation, 0.1);

    // Positional audio
    if (remoteAudioStreams[id]) {
        remoteAudioStreams[id].positionalAudio.position.copy(player.model.position);
    }

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

function removeRemotePlayer(id) {
    if (players[id]) {
        scene.remove(players[id].model);
        delete players[id];
    }
    removeRemoteAudioStream(id);
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

// ----------------------------------------------------
// Audio Streaming
// ----------------------------------------------------

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

// ----------------------------------------------------
// Utility
// ----------------------------------------------------

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

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import SimplexNoise from 'https://cdn.jsdelivr.net/npm/simplex-noise@3.0.0/dist/esm/simplex-noise.min.js';
import { io } from 'https://cdn.socket.io/4.4.1/socket.io.esm.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';


// Initialize Socket.io client
const socket = io('https://full-canary-chokeberry.glitch.me/'); // Replace with your signaling server URL

let scene, camera, renderer;
let myId = null;
let players = {}; 

// XR and Hand Interaction Variables
let controller1, controller2;
let controllerGrip1, controllerGrip2;
let hand1, hand2;
let handModels = { left: null, right: null };

// Terrain Variables
const simplex = new SimplexNoise(); 

// Movement flags for local player
let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;

const velocity = new THREE.Vector3();
const forwardDir = new THREE.Vector3();
const rightDir = new THREE.Vector3();

let previousPinchDistance = null;
const PINCH_THRESHOLD = 0.05; 

// Interpolation factor for remote players
const INTERPOLATION_FACTOR = 0.1; // Adjust for smoother transitions

// Controls for local camera
let controls; // Declare controls globally to manage them if needed

init();
animate();

function init() {
    // Create the scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x333333);

    // Initialize camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    //camera.position.set(0, 1.5, 0.5); // Initial position; will be re-attached per player

    // Initialize renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);

    // Initialize OrbitControls (only for local player; will enable later)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; // Enable damping for smoother controls
    controls.dampingFactor = 0.05;
    controls.enablePan = true; // Enable panning
    controls.enableZoom = false; // Disable zooming if not needed
    controls.enableRotate = true; // Initially enable rotation; will be updated when player is created
    controls.update();

    // Lighting
    const hemiLight = new THREE.HemisphereLight(0xeeeeff, 0x444444, 1);
    hemiLight.position.set(0, 20, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(0, 20, 10);
    dirLight.castShadow = true;
    dirLight.shadow.camera.top = 2;
    dirLight.shadow.camera.bottom = -2;
    dirLight.shadow.camera.left = -2;
    dirLight.shadow.camera.right = 2;
    dirLight.shadow.mapSize.set(4096, 4096);
    scene.add(dirLight);

    // Ground plane
    const floorGeo = new THREE.PlaneGeometry(200, 200);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x444444 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Generate Terrain
    generateTerrain();

    // Handle window resize
    window.addEventListener('resize', onWindowResize);

    // Handle keyboard input
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Add VR Button with hand-tracking
    const sessionInit = {
        requiredFeatures: ['hand-tracking']
    };
    document.body.appendChild(VRButton.createButton(renderer, sessionInit));

    // Controllers and Hand Models
    setupXRControllers();

    // Socket.io event handlers
    socket.on('init', (data) => {
        console.log('Init data:', data); // Debugging
        myId = data.id;
        updatePlayers(data.players);
    });

    socket.on('state_update_all', (data) => {
        console.log('State Update All data:', data); // Debugging
        updatePlayers(data); // Correct: data is the players object
    });

    socket.on('new_player', (data) => {
        console.log('New Player data:', data); // Debugging
        addOrUpdatePlayer(data.id, data);
    });

    socket.on('state_update', (data) => {
        console.log('State Update:', data); // Debugging
        if (players[data.id]) {
            players[data.id].targetX = data.x;
            players[data.id].targetZ = data.z;
            players[data.id].targetRotation = data.rotation || 0;
        }
    });

    socket.on('player_disconnected', (id) => {
        console.log('Player Disconnected:', id); // Debugging
        removePlayer(id);
    });

    // Optional: Handle VR session start/end to toggle OrbitControls
    renderer.xr.addEventListener('sessionstart', () => {
        controls.enabled = false; // Disable OrbitControls in VR
    });

    renderer.xr.addEventListener('sessionend', () => {
        controls.enabled = true; // Enable OrbitControls when exiting VR
    });
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    renderer.setSize(window.innerWidth, window.innerHeight);
}

function setupXRControllers() {
    const controllerModelFactory = new XRControllerModelFactory();
    const handModelFactory = new XRHandModelFactory();

    // Controller 1 (Left)
    controller1 = renderer.xr.getController(0);
    scene.add(controller1);

    controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    hand1 = renderer.xr.getHand(0);
    scene.add(hand1);

    // Use 'boxes' as per the example
    handModels.left = handModelFactory.createHandModel(hand1, 'boxes');
    hand1.add(handModels.left);
    // Do not modify materials as per user's instruction

    // Controller 2 (Right)
    controller2 = renderer.xr.getController(1);
    scene.add(controller2);

    controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);

    hand2 = renderer.xr.getHand(1);
    scene.add(hand2);

    // Use 'boxes' as per the example
    handModels.right = handModelFactory.createHandModel(hand2, 'boxes');
    hand2.add(handModels.right);
    // Do not modify materials as per user's instruction
}

function generateTerrain() {
    const size = 100;
    const segments = 100;
    const halfSize = size / 2;
    const segmentSize = size / segments;

    const distanceRanges = [
        { min: 0, max: size * 0.2, pointSize: 0.02, lineOpacity: 0.0 },
        { min: size * 0.2, max: size * 0.4, pointSize: 0.015, lineOpacity: 0.1 },
        { min: size * 0.4, max: size * 0.5, pointSize: 0.012, lineOpacity: 0.2 },
        { min: size * 0.5, max: size * 0.6, pointSize: 0.01, lineOpacity: 0.4 },
        { min: size * 0.6, max: size * 0.7, pointSize: 0.008, lineOpacity: 0.6 },
        { min: size * 0.7, max: size * 1.0, pointSize: 0.005, lineOpacity: 1.0 },
    ];

    const pointsByRange = distanceRanges.map(() => []);
    const linesByRange = distanceRanges.map(() => []);

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
                    y = simplex.noise2D(x / 20, z / 20) * 2.5;
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
                color: 0x88cc88,
                size: distanceRanges[k].pointSize,
                transparent: true,
                opacity: 0.8
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
                linewidth: 1
            });
            const terrainLines = new THREE.LineSegments(lineGeometry, lineMaterial);
            scene.add(terrainLines);
        }
    }
}

function createPlayer(id, data) {
    if (players[id]) return; 

    // Create a sphere for the player
    const geo = new THREE.SphereGeometry(0.2, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color: data.color });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.castShadow = true;
    sphere.receiveShadow = true;

    // Create stick
    const stickGeo = new THREE.CylinderGeometry(0.05, 0.05, 2, 8);
    const stickMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const stick = new THREE.Mesh(stickGeo, stickMat);
    stick.position.set(0, 1, 0); // Position the stick so that its base is at the sphere's top

    // Create a group for the player
    const playerGroup = new THREE.Group();
    playerGroup.add(sphere);
    playerGroup.add(stick);

    // Attach camera to the stick only if it's the local player
    if (id === myId) {
        // Position the camera at the top of the stick
        camera.position.set(0, 1, 0); // At the top of the stick (stick height is 2, so top is y=1)
        stick.add(camera); // Attach camera directly to the stick

        // Initialize OrbitControls for local camera
        controls.enableRotate = true; // Enable rotation to allow panning/look around
        controls.enablePan = true; // Enable panning
        controls.enableZoom = false; // Disable zooming if not needed

        // Set OrbitControls target to the player's stick position
        const stickWorldPos = new THREE.Vector3();
        stick.getWorldPosition(stickWorldPos);
        controls.target.copy(stickWorldPos);
        controls.update();

        // Ensure only the local player's camera is visible
        camera.visible = true;
    } else {
        // Hide remote players' cameras if they exist
        camera.visible = false;
    }

    scene.add(playerGroup); // Attach to scene

    // Create direction line
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 1)
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: data.color });
    const line = new THREE.Line(lineGeo, lineMat);
    sphere.add(line);

    // Create small spheres for hand positions
    const handSphereGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const handSphereMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const handSpheres = {
        left: new THREE.Mesh(handSphereGeo, handSphereMat),
        right: new THREE.Mesh(handSphereGeo, handSphereMat)
    };
    sphere.add(handSpheres.left);
    sphere.add(handSpheres.right);

    // Initialize player's position and rotation using server data
    players[id] = {
        mesh: playerGroup,
        line: line,
        handSpheres: handSpheres,
        x: data.x || 0,
        z: data.z || 0,
        rotation: data.rotation || 0,
        color: data.color,
        moveForward: false,
        moveBackward: false,
        moveLeft: false,
        moveRight: false,
        targetX: data.x || 0, // For interpolation
        targetZ: data.z || 0,
        targetRotation: data.rotation || 0
    };

    // Set initial position and rotation
    playerGroup.position.set(players[id].x, 0.2, players[id].z);
    playerGroup.rotation.y = players[id].rotation;
    line.rotation.set(0, players[id].rotation, 0);
}

function updatePlayers(updatedPlayers) {
    // Remove disconnected players
    for (let pid in players) {
        if (!(pid in updatedPlayers)) {
            if (players[pid].mesh) {
                scene.remove(players[pid].mesh);
                players[pid].mesh.geometry.dispose();
                players[pid].mesh.material.dispose();
                // Dispose hand spheres
                players[pid].handSpheres.left.geometry.dispose();
                players[pid].handSpheres.left.material.dispose();
                players[pid].handSpheres.right.geometry.dispose();
                players[pid].handSpheres.right.material.dispose();
            }
            if (players[pid].line) {
                scene.remove(players[pid].line);
                players[pid].line.geometry.dispose();
                players[pid].line.material.dispose();
            }
            delete players[pid];
        }
    }

    // Update or add new/updated players
    for (let pid in updatedPlayers) {
        const p = updatedPlayers[pid];
        if (!players[pid]) {
            createPlayer(pid, p);
        } else {
            if (pid !== myId) { 
                players[pid].targetX = p.x;
                players[pid].targetZ = p.z;
                players[pid].targetRotation = p.rotation || 0;
            }
        }
    }
}

function removePlayer(id) {
    if (players[id]) {
        if (players[id].mesh) {
            scene.remove(players[id].mesh);
            players[id].mesh.geometry.dispose();
            players[id].mesh.material.dispose();
            // Dispose hand spheres
            players[id].handSpheres.left.geometry.dispose();
            players[id].handSpheres.left.material.dispose();
            players[id].handSpheres.right.geometry.dispose();
            players[id].handSpheres.right.material.dispose();
        }
        if (players[id].line) {
            scene.remove(players[id].line);
            players[id].line.geometry.dispose();
            players[id].line.material.dispose();
        }
        delete players[id];
    }
}

function onKeyDown(e) {
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
        e.preventDefault();
    }

    console.log(e);

    switch (e.code) {
        case 'KeyW': moveForward = true; break;
        case 'KeyS': moveBackward = true; break;
        case 'KeyA': moveLeft = true; break;
        case 'KeyD': moveRight = true; break;
    }

    socket.emit('key_down', { key: e.code });
}

function onKeyUp(e) {
    switch (e.code) {
        case 'KeyW': moveForward = false; break;
        case 'KeyS': moveBackward = false; break;
        case 'KeyA': moveLeft = false; break;
        case 'KeyD': moveRight = false; break;
    }

    socket.emit('key_up', { key: e.code });
}

function animate() {
    renderer.setAnimationLoop(render);
}

function render() {
    if (myId && players[myId]) {
        const player = players[myId];

        // Update forward and right directions based on camera's current orientation
        camera.getWorldDirection(forwardDir);
        forwardDir.y = 0; // Lock movement to ground plane
        forwardDir.normalize();

        rightDir.set(forwardDir.z, 0, -forwardDir.x).normalize();

        // Reset velocity
        velocity.set(0, 0, 0);
        const moveSpeed = 0.1; // Adjusted speed for better responsiveness

        // Apply local movement flags
        if (moveForward) velocity.addScaledVector(forwardDir, moveSpeed);
        if (moveBackward) velocity.addScaledVector(forwardDir, -moveSpeed);
        if (moveLeft) velocity.addScaledVector(rightDir, -moveSpeed);
        if (moveRight) velocity.addScaledVector(rightDir, moveSpeed);

        // Handle pinch-based movement
        if (hand1 && hand2) {
            const pinchDistanceLeft = getPinchDistance(hand1);
            const pinchDistanceRight = getPinchDistance(hand2);

            const isLeftPinched = pinchDistanceLeft < PINCH_THRESHOLD;
            const isRightPinched = pinchDistanceRight < PINCH_THRESHOLD;

            if (isLeftPinched && isRightPinched) {
                // Compute the distance between both pinch points
                const pinchPointLeft = getPinchPoint(hand1);
                const pinchPointRight = getPinchPoint(hand2);
                const currentPinchDistance = pinchPointLeft.distanceTo(pinchPointRight);

                if (previousPinchDistance !== null) {
                    const deltaDistance = currentPinchDistance - previousPinchDistance;
                    if (deltaDistance > 0.01) { // Threshold for forward movement
                        moveForward = true;
                        moveBackward = false;
                    } else if (deltaDistance < -0.01) { // Threshold for backward movement
                        moveBackward = true;
                        moveForward = false;
                    }
                }

                previousPinchDistance = currentPinchDistance;
            } else {
                previousPinchDistance = null;
            }
        }

        // Update player's position based on movement flags
        player.x += velocity.x;
        player.z += velocity.z;
        player.mesh.position.set(player.x, 0.2, player.z);

        // Update player.rotation based on movement (e.g., left/right keys)
        if (moveLeft) {
            player.rotation += 0.05; // Adjust rotation speed as needed
        }
        if (moveRight) {
            player.rotation -= 0.05;
        }

        // Apply rotation to the player group
        player.mesh.rotation.y = player.rotation;

        // Emit updated position and rotation to server
        socket.emit('move', { x: player.x, z: player.z, rotation: player.rotation });

        // Update the direction line based on local camera's orientation
        const cameraDirection = new THREE.Vector3();
        camera.getWorldDirection(cameraDirection);
        const angle = Math.atan2(cameraDirection.x, cameraDirection.z);
        player.line.rotation.y = angle;

        // **Update OrbitControls target to the player's stick position**
        if (controls) {
            const stickWorldPos = new THREE.Vector3();
            player.mesh.getWorldPosition(stickWorldPos);
            stickWorldPos.y += 1; // Adjust if the camera is offset above the stick
            controls.target.copy(stickWorldPos);
            controls.update();
        }
    }

    // Interpolate remote players' positions and rotations for smoothness
    for (let pid in players) {
        if (pid !== myId) {
            const p = players[pid];

            // Interpolate X position
            p.x += (p.targetX - p.x) * INTERPOLATION_FACTOR;
            // Interpolate Z position
            p.z += (p.targetZ - p.z) * INTERPOLATION_FACTOR;
            // Interpolate rotation
            p.rotation += (p.targetRotation - p.rotation) * INTERPOLATION_FACTOR;

            // Update mesh position and rotation
            p.mesh.position.set(p.x, 0.2, p.z);
            p.mesh.rotation.y = p.rotation;
            p.line.rotation.y = p.rotation; // Set direction line based on rotation
        }
    }

    renderer.render(scene, camera);
}

function updateHandSpheres(player) {
    const leftHandPos = new THREE.Vector3();
    hand1.getWorldPosition(leftHandPos);
    const rightHandPos = new THREE.Vector3();
    hand2.getWorldPosition(rightHandPos);

    const leftLocal = player.mesh.worldToLocal(leftHandPos.clone());
    const rightLocal = player.mesh.worldToLocal(rightHandPos.clone());

    player.handSpheres.left.position.set(leftLocal.x, leftLocal.y, leftLocal.z);
    player.handSpheres.right.position.set(rightLocal.x, rightLocal.y, rightLocal.z);
}

function addOrUpdatePlayer(id, data) {
    if (!players[id]) {
        createPlayer(id, data);
    } else {
        if (id !== myId) { 
            players[id].targetX = data.x;
            players[id].targetZ = data.z;
            players[id].targetRotation = data.rotation || 0;
        }
    }
}

// Pinch detection helpers remain the same
function getPinchDistance(hand) {
    const thumbTip = hand.joints['thumb_tip'];
    const indexTip = hand.joints['index_finger_tip'];
    if (thumbTip && indexTip) {
        const thumbPos = new THREE.Vector3();
        const indexPos = new THREE.Vector3();
        thumbTip.getWorldPosition(thumbPos);
        indexTip.getWorldPosition(indexPos);
        return thumbPos.distanceTo(indexPos);
    }
    return Infinity;
}

function getPinchPoint(hand) {
    const thumbTip = hand.joints['thumb_tip'];
    const indexTip = hand.joints['index_finger_tip'];
    if (thumbTip && indexTip) {
        const thumbPos = new THREE.Vector3();
        const indexPos = new THREE.Vector3();
        thumbTip.getWorldPosition(thumbPos);
        indexTip.getWorldPosition(indexPos);
        return new THREE.Vector3().addVectors(thumbPos, indexPos).multiplyScalar(0.5);
    }
    return new THREE.Vector3();
}

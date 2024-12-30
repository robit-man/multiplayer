// app.js

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js';
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js';

import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { Sky } from 'three/addons/objects/Sky.js';
import { io } from 'https://cdn.socket.io/4.4.1/socket.io.esm.min.js'
// import './terrain.js'
import SimplexNoise from 'https://cdn.jsdelivr.net/npm/simplex-noise@3.0.0/dist/esm/simplex-noise.min.js'

// ------------------------------
// Model path (public vs root)
// ------------------------------
let modelPath
if (window.location.pathname.includes('/public/')) {
    modelPath = '/public/Xbot.glb'
} else {
    modelPath = '/Xbot.glb'
}
console.log(`Model Path: ${modelPath}`)

// ------------------------------
// Socket and Noise
// ------------------------------
const socket = io('https://full-canary-chokeberry.glitch.me/')
const simplex = new SimplexNoise()

// ------------------------------
// Scene / Camera / Renderer
// ------------------------------
let scene, camera, renderer, clock, controls, composer
let listener

// Local player model + animations
let localModel, localMixer
let currentAction = 'idle'
let localActions = {}

// Desktop movement + keys
let moveForward = false
let moveBackward = false
let strafeLeft = false
let strafeRight = false
let isRunning = false

// Mouse look (desktop)
let yaw = 0 // Horizontal rotation (around Y-axis)
let pitch = 0 // Vertical rotation (around X-axis)
const mouseSensitivity = 0.002
const pitchMin = -Math.PI / 2 + 0.01 // Slightly above -90°
const pitchMax = Math.PI / 2 - 0.01 // Slightly below +90°

// VR Teleport
let baseReferenceSpace = null
let floorMesh, markerMesh
let INTERSECTION = null
const tempMatrix = new THREE.Matrix4()

// Key states
const keyStates = {
    w: false,
    a: false,
    s: false,
    d: false,
    Shift: false,
    r: false
}

// Audio
let localStream = null
let mediaStreamSource = null
let processor = null
const remoteAudioStreams = {}

// Multiplayer (remote players)
const loadingPlayers = new Set()
const players = {}
let myId = null
let lastState = {}

// Speed
const walkSpeed = 2
const runSpeed = 5 // Adjusted to a realistic running speed

// Terrain
const terrainSize = 200
const terrainSegments = 200

// Local storage keys
const LS_ID_KEY = 'myUniquePlayerID'
const LS_POS_KEY = 'myLastPosition'

// Track state changes
let lastStateData = null
let lastEmittedState = null

// Localstorage Saving
let lastSaveTime = 0
const SAVE_INTERVAL = 1000 // only save at most once per second
let lastSavedPos = { x: null, z: null, rotation: null }

// ------------------------------
// Device Orientation Data
// ------------------------------
window.orientationData = {
    alpha: 0, // Yaw-like angle (degrees)
    beta: 0, // Pitch-like angle (degrees)
    gamma: 0 // Roll-like angle (degrees) - typically unused here
}

// ------------------------------
// Initialize Sensor Listeners
// ------------------------------
function initializeSensorListeners() {
    if (window.appPermissions && window.appPermissions.orientationGranted) {
        window.addEventListener('deviceorientation', handleOrientation)
        console.log('DeviceOrientation event listener added.')
    }
    if (window.appPermissions && window.appPermissions.motionGranted) {
        window.addEventListener('devicemotion', handleMotion)
        console.log('DeviceMotion event listener added.')
    }
}

// ------------------------------
// Device Orientation Handler
// ------------------------------
function handleOrientation(event) {
    if (!window.appPermissions || !window.appPermissions.orientationGranted)
        return
    window.isOrientationEnabled = true

    // Read raw device orientation (in degrees)
    const { alpha = 0, beta = 0, gamma = 0 } = event

    // Update orientationData
    window.orientationData.alpha = alpha
    window.orientationData.beta = beta
    window.orientationData.gamma = gamma

    // Update UI for debugging
    updateFieldIfNotNull('Orientation_a', alpha, 2) // Display in degrees for clarity
    updateFieldIfNotNull('Orientation_b', beta, 2)
    updateFieldIfNotNull('Orientation_g', gamma, 2)

    incrementEventCount()
}

// ------------------------------
// Device Motion Handler
// ------------------------------
function handleMotion(event) {
    if (!window.appPermissions || !window.appPermissions.motionGranted) return

    if (event.accelerationIncludingGravity) {
        updateFieldIfNotNull(
            'Accelerometer_gx',
            event.accelerationIncludingGravity.x,
            2
        )
        updateFieldIfNotNull(
            'Accelerometer_gy',
            event.accelerationIncludingGravity.y,
            2
        )
        updateFieldIfNotNull(
            'Accelerometer_gz',
            event.accelerationIncludingGravity.z,
            2
        )
    }
    if (event.acceleration) {
        updateFieldIfNotNull('Accelerometer_x', event.acceleration.x, 2)
        updateFieldIfNotNull('Accelerometer_y', event.acceleration.y, 2)
        updateFieldIfNotNull('Accelerometer_z', event.acceleration.z, 2)
    }
    if (event.rotationRate) {
        updateFieldIfNotNull('Gyroscope_z', event.rotationRate.alpha, 2)
        updateFieldIfNotNull('Gyroscope_x', event.rotationRate.beta, 2)
        updateFieldIfNotNull('Gyroscope_y', event.rotationRate.gamma, 2)
    }
    updateFieldIfNotNull('Accelerometer_i', event.interval, 2)

    incrementEventCount()
}

// ------------------------------
// Initialize + Animate
// ------------------------------
init()
animate()

// ------------------------------
// init()
// ------------------------------
function init() {
    // 1) Ensure localStorage ID
    let storedID = localStorage.getItem(LS_ID_KEY)
    if (!storedID) {
        storedID = `user-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        localStorage.setItem(LS_ID_KEY, storedID)
    }
    myId = storedID
    console.log('Using localStorage ID:', myId)

    // Scene
    scene = new THREE.Scene()
    scene.background = new THREE.Color(0x333333)

    // Camera
    camera = new THREE.PerspectiveCamera(
        45,
        window.innerWidth / window.innerHeight,
        1,
        1000000
    )
    camera.position.set(0, 1.7, 0)

    // Audio listener
    listener = new THREE.AudioListener()
    camera.add(listener)

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    renderer.xr.enabled = true
    document.body.appendChild(renderer.domElement)

    // VR Button
    const sessionInit = { requiredFeatures: ['hand-tracking'] }
    document.body.appendChild(VRButton.createButton(renderer, sessionInit))
    renderer.xr.addEventListener('sessionstart', () => {
        baseReferenceSpace = renderer.xr.getReferenceSpace()
    })

    const dirLight = new THREE.DirectionalLight(0xffffff, 1)
    dirLight.position.set(100, 200, 100)
    dirLight.castShadow = true
    dirLight.target.position.set(-5, 0, 0);
    dirLight.shadow.mapSize.set(1024, 1024)
    scene.add(dirLight)

    // Floor (teleport)
    floorMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0
        })
    )
    floorMesh.name = 'teleport_floor'
    scene.add(floorMesh)

    // Initialize Sky
    const sky = new Sky();
    sky.scale.setScalar(450000); // Scale the sky to encompass the scene
    scene.add(sky);

    // Configure Sky Parameters
    const sun = new THREE.Vector3();

    // Define sun parameters
    const elevation = 2; // degrees above the horizon
    const azimuth = 180;  // degrees around the Y-axis

    // Convert spherical coordinates to Cartesian coordinates
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    sun.setFromSphericalCoords(1, phi, theta);

    // Update Sky's sun position
    sky.material.uniforms['sunPosition'].value.copy(sun);

    // Adjust Sky's uniforms to customize appearance
    sky.material.uniforms['turbidity'].value = 10;        // Controls haziness
    sky.material.uniforms['rayleigh'].value = 3;         // Controls sky color
    sky.material.uniforms['mieCoefficient'].value = 0.005; // Controls scattering
    sky.material.uniforms['mieDirectionalG'].value = 0.6;   // Controls scattering direction

    // Add Ambient Light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.2); // Soft white light
    scene.add(ambientLight);

    // Teleport marker
    markerMesh = new THREE.Mesh(
        new THREE.CircleGeometry(0.25, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xbcbcbc })
    )
    markerMesh.visible = false
    scene.add(markerMesh)

    // Pointer Lock Controls (Desktop)
    controls = new PointerLockControls(camera, document.getElementById('app'))

    const instructions = document.getElementById('app')
    instructions.addEventListener('click', function () {
        controls.lock()
    })
    scene.add(controls.object)

    // Load saved camera position if available
    const savedCam = loadPositionFromLocalStorage()
    if (savedCam) {
        console.log('Loaded camera from localStorage:', savedCam)
        camera.position.set(savedCam.x, savedCam.y, savedCam.z)
        camera.rotation.set(0, savedCam.rotation, 0) // Set only yaw; pitch remains as updated via device orientation
    } else {
        console.log('No saved camera location, using defaults...')
    }

    // Postprocessing
    composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))

    const effectFilm = new FilmPass(0.35);
    composer.addPass(effectFilm);

    const effect2 = new ShaderPass(RGBShiftShader)
    effect2.uniforms['amount'].value = 0.0015
    composer.addPass(effect2)

    const effect3 = new OutputPass()
    composer.addPass(effect3)

    // Setup VR controllers
    setupVRControllers()

    // Generate terrain
    //initializeTerrain();

    initializeGeolocation();
    
    loadLocalModel()

    // Keyboard events (Desktop)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)

    // Enable pointer lock (Desktop)
    enablePointerLock()

    // Window resize
    window.addEventListener('resize', onWindowResize)

    // Socket setup
    setupSocketEvents()

    // Clock for animations
    clock = new THREE.Clock()

    // Audio context on user interaction
    document.addEventListener('click', handleUserInteraction, { once: true })
    document.addEventListener('keydown', handleUserInteraction, { once: true })

    // Save local position on unload
    window.addEventListener('beforeunload', savePositionToLocalStorage)

    // Check and initialize sensor listeners based on permissions
    checkPermissions()

    // Call the geolocation initializer
    //generateTerrain()
}
// Flag to prevent multiple initializations
let terrainInitialized = false;

// Expose elevation data to the window object
window.elevationData = [];

// Terrain Point Cloud Objects
let terrainGeometry = null;
let terrainMaterial = null;
let terrainPointCloud = null;
let terrainLineSegments = null; // Line segments for connecting points
let terrainMesh = null; // Mesh surface for the terrain
let terrainMeshWire = null; // Mesh surface for the terrain

// Render Control
const POINTS_BATCH_SIZE = 10; // Number of points to render per frame
let nextPointIndex = 0; // Tracks the next point to fill in the buffer

// Terrain scale multiplier
const scaleMultiplier = 1; // Default scale (1/100)

// Local Storage Key
const LS_TERRAIN_POINTS_KEY = 'terrainPoints';

// Reference elevation for normalization
let referenceElevation = (window.location?.elevation || 0) + 30;

/**
 * Saves a batch of points to localStorage.
 * @param {Array} pointsBatch - Array of point objects to save.
 */
function savePointsToLocalStorage(pointsBatch) {
    let savedPoints = JSON.parse(localStorage.getItem(LS_TERRAIN_POINTS_KEY)) || [];
    savedPoints = savedPoints.concat(pointsBatch);

    try {
        localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(savedPoints));
    } catch (e) {
        console.error("Failed to save terrain points to localStorage:", e);
    }
}

/**
 * Loads saved points from localStorage.
 * @returns {Array} Array of saved point objects.
 */
function loadPointsFromLocalStorage() {
    return JSON.parse(localStorage.getItem(LS_TERRAIN_POINTS_KEY)) || [];
}

/**
 * Fetches elevation data for a grid of geographic points.
 * @param {Array} points - Array of points with latitude and longitude.
 * @param {string} units - 'Meters' or 'Feet'.
 * @param {number} concurrency - Number of concurrent fetches.
 * @param {number} retries - Number of retries for failed fetches.
 * @returns {Promise<void>}
 */
async function fetchElevationGrid(points, units = 'Meters', concurrency = 10, retries = 3) {
    let index = 0;

    /**
     * Fetch elevation with retry logic.
     * @param {number} longitude 
     * @param {number} latitude 
     * @param {number} attempt 
     * @returns {number|null} Elevation value or null if failed.
     */
    const fetchWithRetry = async (longitude, latitude, attempt = 1) => {
        const elevation = await fetchElevation(longitude, latitude, units);
        if (elevation === null && attempt <= retries) {
            console.warn(`Retrying elevation fetch for (${latitude.toFixed(5)}, ${longitude.toFixed(5)}) - Attempt ${attempt + 1}`);
            return await fetchWithRetry(longitude, latitude, attempt + 1);
        }
        return elevation;
    };

    /**
     * Worker function to process grid points.
     */
    const worker = async () => {
        while (true) {
            let currentIndex;
            // Atomically get the next index
            if (index >= points.length) {
                break;
            }
            currentIndex = index++;
            const point = points[currentIndex];
            const elevation = await fetchWithRetry(point.longitude, point.latitude, 1);
            if (elevation !== null) {
                const elevationPoint = {
                    latitude: point.latitude,
                    longitude: point.longitude,
                    elevation: elevation
                };
                window.elevationData.push(elevationPoint);
                console.log(`Lat: ${elevationPoint.latitude.toFixed(5)}, Lon: ${elevationPoint.longitude.toFixed(5)}, Elevation: ${elevationPoint.elevation} meters`);
            } else {
                console.log(`Lat: ${point.latitude.toFixed(5)}, Lon: ${point.longitude.toFixed(5)}, Elevation: Fetch Failed`);
            }
        }
    };

    // Initialize workers
    const workersArray = [];
    for (let i = 0; i < concurrency; i++) {
        workersArray.push(worker());
    }

    // Wait for all workers to complete
    await Promise.all(workersArray);

    console.log("All elevation data fetched.");
}

/**
 * Fetches elevation data for a single geographic point from the USGS EPQS API.
 * @param {number} longitude 
 * @param {number} latitude 
 * @param {string} units - 'Meters' or 'Feet'.
 * @returns {number|null} Elevation value or null if failed.
 */
async function fetchElevation(longitude, latitude, units = 'Meters') {
    const endpoint = 'https://epqs.nationalmap.gov/v1/json';
    const url = `${endpoint}?x=${longitude}&y=${latitude}&units=${units}&output=json`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Elevation API error: ${response.statusText}`);
        }
        const data = await response.json();
        if (data && data.value !== undefined) {
            return data.value; // Elevation in the specified units
        } else {
            throw new Error('Invalid elevation data received.');
        }
    } catch (error) {
        console.error(`Failed to fetch elevation for (${latitude.toFixed(5)}, ${longitude.toFixed(5)}):`, error);
        return null; // Indicate failure
    }
}

// Listen for the custom 'locationUpdated' event
window.addEventListener('locationUpdated', async () => {
    if (terrainInitialized) {
        console.log("Terrain has already been initialized.");
        return;
    }

    const { latitude, longitude } = window;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        console.error("Latitude and Longitude must be set on the window object as numbers.");
        return;
    }

    console.log(`Initializing terrain for Latitude: ${latitude}, Longitude: ${longitude}`);
    terrainInitialized = true;

    try {
        // Step 1: Generate 200x200 Grid Points
        const gridSizeMeters = 1000;
        const gridResolution = 200;
        const gridPoints = generateGrid({ latitude, longitude }, gridSizeMeters, gridResolution);

        console.log(`Generated ${gridPoints.length} grid points.`);

        // Step 2: Initialize Terrain Point Cloud
        initializeTerrainPointCloud();

        // Step 3: Load saved points from localStorage
        const savedPoints = loadPointsFromLocalStorage();
        if (savedPoints.length > 0) {
            console.log(`Loaded ${savedPoints.length} points from localStorage.`);
            populateTerrainFromSavedPoints(savedPoints);
            nextPointIndex = savedPoints.length;
        }

        // Step 4: Fetch remaining elevation data
        const remainingPoints = gridPoints.slice(nextPointIndex);
        if (remainingPoints.length > 0) {
            await fetchElevationGrid(remainingPoints, 'Meters', 10, 3);
            console.log('Started fetching elevation data for remaining points.');
            // After fetching, render the points
            requestAnimationFrame(renderTerrainPoints);
        } else {
            console.log('All terrain points loaded from localStorage.');
            // Draw lines and create mesh if all points are loaded
            drawTerrainLinesAsync(savedPoints); // Use asynchronous line drawing
            createTerrainMesh(savedPoints);
        }

    } catch (error) {
        console.error("Error during terrain initialization:", error);
    }
});

/**
 * Generates a 200x200 grid of geographic points around a center location.
 * @param {Object} center - Object with latitude and longitude.
 * @param {number} gridSizeMeters - Size of the grid in meters.
 * @param {number} gridResolution - Number of points per axis.
 * @returns {Array} Array of point objects with latitude and longitude.
 */
function generateGrid(center, gridSizeMeters = 1000, gridResolution = 200) {
    const points = [];
    const stepMeters = (2 * gridSizeMeters) / gridResolution;

    const deltaLat = stepMeters / 111000;
    const deltaLon = stepMeters / (111000 * Math.cos(THREE.MathUtils.degToRad(center.latitude)));

    for (let i = 0; i < gridResolution; i++) {
        for (let j = 0; j < gridResolution; j++) {
            const latOffset = (i - gridResolution / 2) * deltaLat;
            const lonOffset = (j - gridResolution / 2) * deltaLon;

            points.push({
                latitude: center.latitude + latOffset,
                longitude: center.longitude + lonOffset
            });
        }
    }

    return points;
}

/**
 * Initializes the Three.js terrain point cloud.
 */
function initializeTerrainPointCloud() {
    const totalPoints = 200 * 200;
    const positions = new Float32Array(totalPoints * 3);
    const colors = new Float32Array(totalPoints * 3);

    terrainGeometry = new THREE.BufferGeometry();
    terrainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    terrainMaterial = new THREE.PointsMaterial({
        size: 0.05,
        vertexColors: true,
        transparent: true,
        opacity: 0.5
    });

    terrainPointCloud = new THREE.Points(terrainGeometry, terrainMaterial);
    scene.add(terrainPointCloud);
}

/**
 * Populates the terrain with saved points.
 * @param {Array} savedPoints - Array of saved point objects.
 */
function populateTerrainFromSavedPoints(savedPoints) {
    const positions = terrainPointCloud.geometry.attributes.position.array;
    const colors = terrainPointCloud.geometry.attributes.color.array;
    const metersPerDegLat = 111320 * scaleMultiplier;
    const metersPerDegLon = 110540 * scaleMultiplier;

    savedPoints.forEach((point, index) => {
        const baseIndex = index * 3;
        positions[baseIndex] = (point.longitude - window.longitude) * metersPerDegLon;
        positions[baseIndex + 1] = (point.elevation - referenceElevation) * scaleMultiplier;
        positions[baseIndex + 2] = (point.latitude - window.latitude) * metersPerDegLat;

        const normalizedElevation = Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80;
        const color = new THREE.Color().lerpColors(
            new THREE.Color(0x5555ff), // Blue for low elevation
            new THREE.Color(0xff5555), // Red for high elevation
            normalizedElevation
        );

        colors[baseIndex] = color.r;
        colors[baseIndex + 1] = color.g;
        colors[baseIndex + 2] = color.b;
    });

    terrainPointCloud.geometry.attributes.position.needsUpdate = true;
    terrainPointCloud.geometry.attributes.color.needsUpdate = true;

    console.log(`Populated terrain with ${savedPoints.length} saved points.`);
}

/**
 * Renders new terrain points into the scene.
 */
function renderTerrainPoints() {
    if (!terrainPointCloud || window.elevationData.length === 0) return;

    const positions = terrainPointCloud.geometry.attributes.position.array;
    const colors = terrainPointCloud.geometry.attributes.color.array;
    const totalPoints = 200 * 200;

    const pointsToAdd = Math.min(POINTS_BATCH_SIZE, window.elevationData.length, totalPoints - nextPointIndex);

    if (pointsToAdd <= 0) {
        // Once all points are rendered, draw lines and create mesh
        const allSavedPoints = loadPointsFromLocalStorage();
        drawTerrainLinesAsync(allSavedPoints); // Asynchronous line drawing
        createTerrainMesh(allSavedPoints);
        return;
    }

    const pointsBatch = [];
    for (let i = 0; i < pointsToAdd; i++) {
        const point = window.elevationData.shift();
        if (!point) continue;

        const baseIndex = nextPointIndex * 3;

        positions[baseIndex] = (point.longitude - window.longitude) * 110540 * scaleMultiplier;
        positions[baseIndex + 1] = (point.elevation - referenceElevation) * scaleMultiplier;
        positions[baseIndex + 2] = (point.latitude - window.latitude) * 111320 * scaleMultiplier;

        const normalizedElevation = Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80;
        const color = new THREE.Color().lerpColors(
            new THREE.Color(0x5555ff), // Blue for low elevation
            new THREE.Color(0xff5555), // Red for high elevation
            normalizedElevation
        );

        colors[baseIndex] = color.r;
        colors[baseIndex + 1] = color.g;
        colors[baseIndex + 2] = color.b;

        pointsBatch.push(point);
        nextPointIndex++;
    }

    terrainPointCloud.geometry.attributes.position.needsUpdate = true;
    terrainPointCloud.geometry.attributes.color.needsUpdate = true;

    savePointsToLocalStorage(pointsBatch);

    console.log(`Rendered ${nextPointIndex} / 40000 points.`);

    if (nextPointIndex >= totalPoints) {
        // All points rendered, draw lines and create mesh
        const allSavedPoints = loadPointsFromLocalStorage();
        drawTerrainLinesAsync(allSavedPoints); // Asynchronous line drawing
        createTerrainMesh(allSavedPoints);
    } else {
        // Continue rendering in the next frame
        requestAnimationFrame(renderTerrainPoints);
    }
}

/**
 * Asynchronously draws lines between grid points without wrapping.
 * Should be called within the animate loop.
 * @param {Array} savedPoints - Array of saved point objects.
 */
function drawTerrainLinesAsync(savedPoints) {
    if (!lineDrawingGenerator) {
        lineDrawingGenerator = terrainLineDrawingGenerator(savedPoints);
    }

    const result = lineDrawingGenerator.next();
    if (result.done) {
        lineDrawingGenerator = null; // Reset generator when done
        console.log("Asynchronous terrain lines drawing completed.");
    }
}

let lineDrawingGenerator = null;
/**
 * Generator function that yields line drawing tasks incrementally.
 * @param {Array} savedPoints - Array of saved point objects.
 */
function* terrainLineDrawingGenerator(savedPoints) {
    const linePositions = [];
    const metersPerDegLat = 111320 * scaleMultiplier;
    const metersPerDegLon = 110540 * scaleMultiplier;

    const gridSize = Math.sqrt(savedPoints.length);
    if (!Number.isInteger(gridSize)) {
        console.error("Grid size is not a perfect square. Cannot draw lines accurately.");
        return;
    }

    // Define the maximum allowed distance between connected points (in meters)
    const maxLineDistance = 15; // Adjust this value based on your grid density
    const maxLineDistanceSq = maxLineDistance * maxLineDistance; // Squared distance for efficiency

    // Function to calculate squared distance between two points (X and Z axes only)
    const calculateDistanceSq = (x1, z1, x2, z2) => {
        const dx = x1 - x2;
        const dz = z1 - z2;
        return dx * dx + dz * dz;
    };

    // Set to track connected pairs and prevent duplicates
    const connectedPairs = new Set();

    for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
            const currentIndex = i * gridSize + j;
            const currentPoint = savedPoints[currentIndex];
            if (!currentPoint) continue;

            const currentX = (currentPoint.longitude - window.longitude) * metersPerDegLon;
            const currentZ = (currentPoint.latitude - window.latitude) * metersPerDegLat;
            const currentY = (currentPoint.elevation - referenceElevation) * scaleMultiplier;

            // Right neighbor (only if not on the last column)
            if (j < gridSize - 1) {
                const rightNeighborIndex = currentIndex + 1;
                const rightNeighbor = savedPoints[rightNeighborIndex];
                if (rightNeighbor) {
                    const rightX = (rightNeighbor.longitude - window.longitude) * metersPerDegLon;
                    const rightZ = (rightNeighbor.latitude - window.latitude) * metersPerDegLat;
                    const rightY = (rightNeighbor.elevation - referenceElevation) * scaleMultiplier;

                    const distanceSq = calculateDistanceSq(currentX, currentZ, rightX, rightZ);
                    if (distanceSq <= maxLineDistanceSq) {
                        // Create a unique key for the pair to prevent duplicates
                        const key = currentIndex < rightNeighborIndex
                            ? `${currentIndex}-${rightNeighborIndex}`
                            : `${rightNeighborIndex}-${currentIndex}`;

                        if (!connectedPairs.has(key)) {
                            connectedPairs.add(key);
                            linePositions.push(
                                currentX, currentY, currentZ,
                                rightX, rightY, rightZ
                            );
                        }
                    }
                }
            }

            // Bottom neighbor (only if not on the last row)
            if (i < gridSize - 1) {
                const bottomNeighborIndex = currentIndex + gridSize;
                const bottomNeighbor = savedPoints[bottomNeighborIndex];
                if (bottomNeighbor) {
                    const bottomX = (bottomNeighbor.longitude - window.longitude) * metersPerDegLon;
                    const bottomZ = (bottomNeighbor.latitude - window.latitude) * metersPerDegLat;
                    const bottomY = (bottomNeighbor.elevation - referenceElevation) * scaleMultiplier;

                    const distanceSq = calculateDistanceSq(currentX, currentZ, bottomX, bottomZ);
                    if (distanceSq <= maxLineDistanceSq) {
                        // Create a unique key for the pair to prevent duplicates
                        const key = currentIndex < bottomNeighborIndex
                            ? `${currentIndex}-${bottomNeighborIndex}`
                            : `${bottomNeighborIndex}-${currentIndex}`;

                        if (!connectedPairs.has(key)) {
                            connectedPairs.add(key);
                            linePositions.push(
                                currentX, currentY, currentZ,
                                bottomX, bottomY, bottomZ
                            );
                        }
                    }
                }
            }

            // Yield after processing a set number of points to allow the main thread to breathe
            if ((i * gridSize + j) % 1000 === 0) { // Adjust the modulus value based on desired yield frequency
                yield;
            }
        }
    }

    // After all lines are collected, create the line segments
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.5, transparent: true });
    terrainLineSegments = new THREE.LineSegments(lineGeometry, lineMaterial);
    scene.add(terrainLineSegments);

    yield; // Final yield to indicate completion
}

const gridRows = 200; // Number of rows in the grid
const gridCols = 200; // Number of columns in the grid

function createTerrainMesh(savedPoints) {
    // Ensure gridRows and gridCols are defined
    if (typeof gridRows === 'undefined' || typeof gridCols === 'undefined') {
        console.error("gridRows and gridCols must be defined before creating the terrain mesh.");
        return;
    }

    // Validate the length of savedPoints
    if (savedPoints.length > gridRows * gridCols) {
        console.error(`Expected at most ${gridRows * gridCols} points, but got ${savedPoints.length}.`);
        return;
    }

    // Define meters per degree based on a fixed latitude for simplicity
    const metersPerDegLat = 111320 * scaleMultiplier;
    const metersPerDegLon = 110540 * scaleMultiplier; // Adjust based on average latitude if necessary

    // Define origin for global positioning (adjust as needed)
    const originLongitude = window.longitude; // Reference longitude
    const originLatitude = window.latitude;   // Reference latitude

    // Function to calculate squared distance between two points (X and Z axes only)
    const calculateDistanceSq = (x1, z1, x2, z2) => {
        const dx = x1 - x2;
        const dz = z1 - z2;
        return dx * dx + dz * dz;
    };

    // Step 1: Determine global min and max for X (longitude) and Z (latitude)
    const xCoords = savedPoints.map(point => (point.longitude - originLongitude) * metersPerDegLon);
    const zCoords = savedPoints.map(point => (point.latitude - originLatitude) * metersPerDegLat);

    const minX = Math.min(...xCoords);
    const maxX = Math.max(...xCoords);
    const minZ = Math.min(...zCoords);
    const maxZ = Math.max(...zCoords);

    // Calculate expected grid spacing
    const deltaX = (maxX - minX) / (gridCols - 1);
    const deltaZ = (maxZ - minZ) / (gridRows - 1);

    // Initialize a 2D array to hold sorted points
    const sortedGrid = Array.from({ length: gridRows }, () => Array(gridCols).fill(null));

    // Step 2: Assign each saved point to the appropriate grid cell
    savedPoints.forEach(point => {
        // Convert geographic coordinates to meters relative to origin
        const x = (point.longitude - originLongitude) * metersPerDegLon;
        const z = (point.latitude - originLatitude) * metersPerDegLat;

        // Calculate column and row indices based on grid spacing
        let col = Math.round((x - minX) / deltaX);
        let row = Math.round((z - minZ) / deltaZ);

        // Clamp indices to valid range
        col = Math.max(0, Math.min(gridCols - 1, col));
        row = Math.max(0, Math.min(gridRows - 1, row));

        // Assign the point to the grid cell
        if (sortedGrid[row][col] === null) {
            sortedGrid[row][col] = point;
        } else {
            // Handle duplicate assignments by choosing the closest point
            const existingPoint = sortedGrid[row][col];
            const existingX = (existingPoint.longitude - originLongitude) * metersPerDegLon;
            const existingZ = (existingPoint.latitude - originLatitude) * metersPerDegLat;
            const existingDistanceSq = calculateDistanceSq(existingX, existingZ, x, z);

            // Calculate distance for the new point (should be zero if exact duplicate)
            const newDistanceSq = calculateDistanceSq(existingX, existingZ, x, z);

            if (newDistanceSq < existingDistanceSq) {
                sortedGrid[row][col] = point;
            } else {
                console.warn(`Duplicate point assignment at row ${row}, col ${col}. Keeping the existing point.`);
            }
        }
    });

    // Step 3: Handle Missing Points by Generating Them
    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            if (sortedGrid[row][col] === null) {
                console.warn(`Missing point at row ${row}, col ${col}. Generating a new point.`);

                // Calculate longitude and latitude based on grid indices
                const x = minX + col * deltaX;
                const z = minZ + row * deltaZ;

                // Determine neighbors for elevation interpolation
                const neighbors = [];

                // Define neighbor offsets (Left, Right, Below, Above)
                const neighborOffsets = [
                    [row, col - 1], // Left
                    [row, col + 1], // Right
                    [row - 1, col], // Below
                    [row + 1, col]  // Above
                ];

                neighborOffsets.forEach(offset => {
                    const [nRow, nCol] = offset;
                    if (nRow >= 0 && nRow < gridRows && nCol >= 0 && nCol < gridCols) {
                        const neighborPoint = sortedGrid[nRow][nCol];
                        if (neighborPoint !== null) {
                            neighbors.push(neighborPoint.elevation);
                        }
                    }
                });

                // Calculate average elevation from neighbors
                let averageElevation = referenceElevation; // Default elevation if no neighbors
                if (neighbors.length > 0) {
                    const sum = neighbors.reduce((acc, val) => acc + val, 0);
                    averageElevation = sum / neighbors.length;
                }

                // Convert x and z back to longitude and latitude
                const generatedLongitude = x / metersPerDegLon + originLongitude;
                const generatedLatitude = z / metersPerDegLat + originLatitude;

                // Create the generated point
                const generatedPoint = {
                    longitude: generatedLongitude,
                    latitude: generatedLatitude,
                    elevation: averageElevation
                };

                // Assign the generated point to the grid
                sortedGrid[row][col] = generatedPoint;
            }
        }
    }

    // Step 4: Populate Vertices and Colors
    const totalPoints = gridRows * gridCols;
    const vertices = new Float32Array(totalPoints * 3); // x, y, z for each point
    const colors = new Float32Array(totalPoints * 3);   // r, g, b for each point

    for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
            const index = row * gridCols + col;
            const point = sortedGrid[row][col];
            const vertexIndex = index * 3;

            // Convert geographic coordinates to meters relative to origin
            const x = (point.longitude - originLongitude) * metersPerDegLon; // x
            const y = (point.elevation - referenceElevation) * scaleMultiplier; // y
            const z = (point.latitude - originLatitude) * metersPerDegLat; // z

            vertices[vertexIndex] = x;
            vertices[vertexIndex + 1] = y;
            vertices[vertexIndex + 2] = z;

            // Calculate color based on elevation
            const normalizedElevation = Math.min(Math.max(point.elevation - referenceElevation, 0), 100) / 100;
            const color = new THREE.Color().lerpColors(
                new THREE.Color(0xaaaaff), // Blue for low elevation
                new THREE.Color(0xffaaaa), // Red for high elevation
                normalizedElevation
            );
            colors[vertexIndex] = color.r;
            colors[vertexIndex + 1] = color.g;
            colors[vertexIndex + 2] = color.b;
        }
    }

    // Step 5: Generate Indices for Triangles Based on Physical Neighbors
    const indices = [];
    const maxTriangleSize = 400; // Adjust based on grid density
    const maxTriangleSizeSq = maxTriangleSize * maxTriangleSize; // Squared distance for efficiency

    for (let row = 0; row < gridRows - 1; row++) {
        for (let col = 0; col < gridCols - 1; col++) {
            const a = row * gridCols + col;
            const b = a + 1;
            const c = a + gridCols;
            const d = c + 1;

            // Retrieve vertex positions (X and Z axes only)
            const ax = vertices[a * 3];
            const az = vertices[a * 3 + 2];
            const bx = vertices[b * 3];
            const bz = vertices[b * 3 + 2];
            const cx = vertices[c * 3];
            const cz = vertices[c * 3 + 2];
            const dxPos = vertices[d * 3];
            const dz = vertices[d * 3 + 2];

            // Calculate squared distances to ensure physical proximity
            const distanceACSq = calculateDistanceSq(ax, az, cx, cz);
            const distanceCBSq = calculateDistanceSq(cx, cz, bx, bz);
            const distanceABSq = calculateDistanceSq(ax, az, bx, bz);

            const distanceBCSq = calculateDistanceSq(bx, bz, cx, cz);
            const distanceCDSq = calculateDistanceSq(cx, cz, dxPos, dz);
            const distanceBDSq = calculateDistanceSq(bx, bz, dxPos, dz);

            // Validate distances for the first triangle (a, c, b)
            const isTriangle1Valid = distanceACSq <= maxTriangleSizeSq &&
                distanceCBSq <= maxTriangleSizeSq &&
                distanceABSq <= maxTriangleSizeSq;

            // Validate distances for the second triangle (b, c, d)
            const isTriangle2Valid = distanceBCSq <= maxTriangleSizeSq &&
                distanceCDSq <= maxTriangleSizeSq &&
                distanceBDSq <= maxTriangleSizeSq;

            // Only add triangles if they pass the distance validation
            if (isTriangle1Valid && isTriangle2Valid) {
                // First triangle (a, c, b)
                indices.push(a, c, b);

                // Second triangle (b, c, d)
                indices.push(b, c, d);
            } else {
                console.warn(`Skipped grid square at row ${row}, col ${col} due to excessive triangle size.`);
            }
        }
    }

    // Step 6: Assign Attributes to Geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Step 7: Create Material with Vertex Colors, Shading, and Reflectivity
    const materialWire = new THREE.MeshStandardMaterial({
        vertexColors: true,        // Enable vertex colors
        wireframe: true,          // Set to true if wireframe is desired
        transparent: true,         // Enable transparency
        opacity: 0.5,              // Set opacity level
        metalness: 0.5,            // Slight reflectivity (range: 0.0 - 1.0)
        roughness: 0.2,            // Moderate roughness for shading (range: 0.0 - 1.0)

        // Optional: Add an environment map for enhanced reflections
        // envMap: yourEnvironmentMap,      // Replace with your environment map texture
        // envMapIntensity: 1.0,            // Adjust the intensity of the environment map
    });

    // Step 7: Create Material with Vertex Colors, Shading, and Reflectivity
    const material = new THREE.MeshStandardMaterial({
        vertexColors: true,        // Enable vertex colors
        wireframe: false,          // Set to true if wireframe is desired
        transparent: true,         // Enable transparency
        opacity: 0.95,              // Set opacity level
        metalness: 0.3,            // Slight reflectivity (range: 0.0 - 1.0)
        roughness: 0.7,            // Moderate roughness for shading (range: 0.0 - 1.0)

        // Optional: Add an environment map for enhanced reflections
        // envMap: yourEnvironmentMap,      // Replace with your environment map texture
        // envMapIntensity: 1.0,            // Adjust the intensity of the environment map
    });


    // Step 8: Create and Add the Terrain Mesh to the Scene
    terrainMesh = new THREE.Mesh(geometry, material);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);

    // Step 8: Create and Add the Terrain Mesh to the Scene
    terrainMeshWire = new THREE.Mesh(geometry, materialWire);
    scene.add(terrainMeshWire);

    console.log("Terrain mesh created and added to the scene.");
}


/**
 * Helper function to find the closest grid point and reposition the camera.
 */
function repositionCameraAboveClosestGridPoint() {
    if (!terrainPointCloud || !localModel) return;

    // Extract the local model's current x and z positions
    const userX = localModel.position.x;
    const userZ = localModel.position.z;

    // Find the closest grid point
    const closestPoint = findClosestGridPoint(userX, userZ);

    if (closestPoint) {
        // Set the camera's position to be 1.7 units above the closest grid point
        camera.position.set(
            closestPoint.x,
            closestPoint.y + 1.7,
            closestPoint.z
        );

        // Optionally, update the local model's position to match the closest point
        localModel.position.set(
            closestPoint.x,
            closestPoint.y,
            closestPoint.z
        );

        // Update the camera to look at the local model
        //camera.lookAt(localModel.position);
    }
}

/**
 * Finds the closest grid point to the given x and z coordinates.
 * @param {number} x - The x-coordinate of the user.
 * @param {number} z - The z-coordinate of the user.
 * @returns {Object|null} The closest grid point with x, y, z properties or null if not found.
 */
function findClosestGridPoint(x, z) {
    if (!terrainPointCloud) return null;

    const positions = terrainPointCloud.geometry.attributes.position.array;
    let minDistance = Infinity;
    let closestPoint = null;

    // Iterate through all points to find the closest one
    for (let i = 0; i < positions.length; i += 3) {
        const pointX = positions[i];
        const pointY = positions[i + 1];
        const pointZ = positions[i + 2];

        const dx = x - pointX;
        const dz = z - pointZ;
        const distance = dx * dx + dz * dz; // Compare squared distances for efficiency

        if (distance < minDistance) {
            minDistance = distance;
            closestPoint = { x: pointX, y: pointY, z: pointZ };
        }
    }

    return closestPoint;
}

// ------------------------------
// Save + Load local position
// ------------------------------
function savePositionToLocalStorage() {
    if (!camera) return

    // Grab camera position and yaw
    const pos = {
        x: camera.position.x,
        y: camera.position.y, // optional if you also care about vertical
        z: camera.position.z,
        rotation: getCameraYaw() // yaw in radians
    }

    localStorage.setItem(LS_POS_KEY, JSON.stringify(pos))
    console.log('Saved camera position to LS:', pos)
}

function loadPositionFromLocalStorage() {
    const raw = localStorage.getItem(LS_POS_KEY)
    if (!raw) return null
    try {
        const data = JSON.parse(raw)
        if (
            typeof data.x === 'number' &&
            typeof data.y === 'number' &&
            typeof data.z === 'number' &&
            typeof data.rotation === 'number'
        ) {
            return data
        }
    } catch (e) {
        console.warn('Error parsing camera position from LS:', e)
    }
    return null
}

// Given Changes in location
function maybeSavePositionToLocalStorage() {
    if (!camera) return // camera is authority
    const x = camera.position.x
    const y = camera.position.y
    const z = camera.position.z
    const r = getCameraYaw()

    const THRESHOLD = 0.001
    const posChanged =
        lastSavedPos.x === null ||
        Math.abs(x - lastSavedPos.x) > THRESHOLD ||
        Math.abs(z - lastSavedPos.z) > THRESHOLD ||
        Math.abs(r - lastSavedPos.rotation) > THRESHOLD

    if (posChanged) {
        const pos = { x, y, z, rotation: r }
        localStorage.setItem(LS_POS_KEY, JSON.stringify(pos))
        console.log('Saved camera to localStorage:', pos)
        lastSavedPos = { x, y, z, rotation: r }
    }
}

// ------------------------------
// Pointer Lock for Desktop
// ------------------------------
function enablePointerLock() {
    const canvas = renderer.domElement
    canvas.addEventListener('click', () => {
        if (!renderer.xr.isPresenting) {
            canvas.requestPointerLock()
        }
    })
    document.addEventListener('mousemove', e => {
        if (document.pointerLockElement === canvas && !renderer.xr.isPresenting) {
            yaw -= e.movementX * mouseSensitivity
            pitch -= e.movementY * mouseSensitivity
            if (pitch < pitchMin) pitch = pitchMin
            if (pitch > pitchMax) pitch = pitchMax
            console.log(
                `Pitch: ${THREE.MathUtils.radToDeg(pitch).toFixed(
                    2
                )}°, Yaw: ${THREE.MathUtils.radToDeg(yaw).toFixed(2)}°`
            )

            // Update camera rotation
            camera.rotation.set(pitch, yaw, 0, 'YXZ')
        }
    })
}

// ------------------------------
// VR Controllers / Teleport
// ------------------------------
function setupVRControllers() {
    const controller1 = renderer.xr.getController(0)
    const controller2 = renderer.xr.getController(1)

    function onSelectStart() {
        this.userData.isSelecting = true
    }
    function onSelectEnd() {
        this.userData.isSelecting = false
        if (!INTERSECTION || !baseReferenceSpace) return

        // offset-based XR ref
        const offsetPosition = {
            x: -INTERSECTION.x,
            y: -INTERSECTION.y,
            z: -INTERSECTION.z,
            w: 1
        }
        const offsetRotation = new THREE.Quaternion()
        const transform = new XRRigidTransform(offsetPosition, offsetRotation)
        const terrainHeight = getTerrainHeightAt(localModel.position.x, localModel.position.z);

        const teleportSpaceOffset =
            baseReferenceSpace.getOffsetReferenceSpace(transform)
        renderer.xr.setReferenceSpace(teleportSpaceOffset)

        // Move localModel
        localModel.position.set(
            INTERSECTION.x,
            terrainHeight,
            INTERSECTION.z
        )
        emitMovementIfChanged({
            x: localModel.position.x,
            z: localModel.position.z,
            rotation: currentAction
        })
    }

    controller1.addEventListener('selectstart', onSelectStart)
    controller1.addEventListener('selectend', onSelectEnd)
    controller2.addEventListener('selectstart', onSelectStart)
    controller2.addEventListener('selectend', onSelectEnd)

    controller1.addEventListener('connected', function (evt) {
        this.add(buildControllerRay(evt.data))
    })
    controller1.addEventListener('disconnected', function () {
        this.remove(this.children[0])
    })

    controller2.addEventListener('connected', function (evt) {
        this.add(buildControllerRay(evt.data))
    })
    controller2.addEventListener('disconnected', function () {
        this.remove(this.children[0])
    })

    scene.add(controller1, controller2)

    const controllerModelFactory = new XRControllerModelFactory()
    const controllerGrip1 = renderer.xr.getControllerGrip(0)
    controllerGrip1.add(
        controllerModelFactory.createControllerModel(controllerGrip1)
    )
    scene.add(controllerGrip1)

    const controllerGrip2 = renderer.xr.getControllerGrip(1)
    controllerGrip2.add(
        controllerModelFactory.createControllerModel(controllerGrip2)
    )
    scene.add(controllerGrip2)
}

function buildControllerRay(data) {
    let geometry, material
    switch (data.targetRayMode) {
        case 'tracked-pointer':
            geometry = new THREE.BufferGeometry()
            geometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3)
            )
            geometry.setAttribute(
                'color',
                new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0, 0, 0], 3)
            )
            material = new THREE.LineBasicMaterial({
                vertexColors: true,
                blending: THREE.AdditiveBlending
            })
            return new THREE.Line(geometry, material)

        case 'gaze':
            geometry = new THREE.RingGeometry(0.02, 0.04, 32).translate(0, 0, -1)
            material = new THREE.MeshBasicMaterial({
                opacity: 0.5,
                transparent: true
            })
            return new THREE.Mesh(geometry, material)
    }
    return new THREE.Object3D()
}

// ------------------------------
// Desktop Key Events
// ------------------------------
function onKeyDown(e) {
    switch (e.key.toLowerCase()) {
        case 'w':
            keyStates.w = true
            break
        case 's':
            keyStates.s = true
            break
        case 'a':
            keyStates.a = true
            break
        case 'd':
            keyStates.d = true
            break
        case 'shift':
            keyStates.Shift = true
            break
        case 'r':
            if (!keyStates.r) startBroadcast()
            keyStates.r = true
            break
    }
    handleKeyStates()
}

function onKeyUp(e) {
    switch (e.key.toLowerCase()) {
        case 'w':
            keyStates.w = false
            break
        case 's':
            keyStates.s = false
            break
        case 'a':
            keyStates.a = false
            break
        case 'd':
            keyStates.d = false
            break
        case 'shift':
            keyStates.Shift = false
            break
        case 'r':
            stopBroadcast()
            keyStates.r = false
            break
    }
    handleKeyStates()
}

function handleKeyStates() {
    moveForward = keyStates.w
    moveBackward = keyStates.s
    strafeLeft = keyStates.a
    strafeRight = keyStates.d
    isRunning =
        keyStates.Shift &&
        (moveForward || moveBackward || strafeLeft || strafeRight)

    let action = 'idle'
    if (moveForward || moveBackward || strafeLeft || strafeRight) {
        action = isRunning ? 'run' : 'walk'
    }
    setLocalAction(action)
}

// ------------------------------
// Desktop Movement + Mouse Look
// ------------------------------
function moveLocalCharacterDesktop(delta) {
    if (!localModel) return

    const speed = isRunning ? runSpeed : walkSpeed
    const forwardVec = new THREE.Vector3()
    const rightVec = new THREE.Vector3()

    // cameraYaw from camera's quaternion
    const cameraYaw = new THREE.Euler().setFromQuaternion(
        camera.quaternion,
        'YXZ'
    ).y

    forwardVec.set(0, 0, -1).applyEuler(new THREE.Euler(0, cameraYaw, 0))
    rightVec.set(1, 0, 0).applyEuler(new THREE.Euler(0, cameraYaw, 0))

    const movement = new THREE.Vector3()
    if (moveForward) movement.add(forwardVec)
    if (moveBackward) movement.sub(forwardVec)
    if (strafeLeft) movement.sub(rightVec)
    if (strafeRight) movement.add(rightVec)

    if (movement.length() > 0) {
        movement.normalize().multiplyScalar(speed * delta)
        localModel.position.add(movement)

        // Adjust camera's y-position based on terrain
        const terrainHeight = getTerrainHeightAt(localModel.position.x, localModel.position.z)
        localModel.position.y = terrainHeight

        // Keep camera ~1.7m above player
        const cameraOffset = new THREE.Vector3(0, 1.7, 0)
        camera.position.copy(localModel.position.clone().add(cameraOffset))
    }

    // Local model faces camera direction
    localModel.rotation.y = (cameraYaw + Math.PI) % (Math.PI * 2)
    maybeSavePositionToLocalStorage()

    // Broadcast movement
    const newAction =
        movement.length() > 0 ? (isRunning ? 'run' : 'walk') : 'idle'
    emitMovementIfChanged({
        x: localModel.position.x,
        z: localModel.position.z,
        rotation: localModel.rotation.y,
        action: newAction
    })

    // Trigger animations
    if (currentAction !== newAction) {
        setLocalAction(newAction)
        currentAction = newAction
    }
}

/**
 * Retrieves the terrain height at a given x and z position using raycasting.
 * @param {number} x - The x-coordinate in the world.
 * @param {number} z - The z-coordinate in the world.
 * @returns {number} The y-coordinate (elevation) of the terrain at the specified x and z.
 */
function getTerrainHeightAt(x, z) {
    if (!terrainMesh) return 0

    // Create a raycaster pointing downwards from a high y value
    const rayOrigin = new THREE.Vector3(x, 1000, z)
    const rayDirection = new THREE.Vector3(0, -1, 0)
    const raycaster = new THREE.Raycaster(rayOrigin, rayDirection)

    const intersects = raycaster.intersectObject(terrainMesh)
    if (intersects.length > 0) {
        return intersects[0].point.y
    }

    // Default to 0 if no intersection
    return 0
}

// ------------------------------
// VR Movement
// ------------------------------
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

            // Incorporate run logic via a button check:
            // e.g., isRunning = buttons[1].pressed (typically the trigger)
            isRunning = buttons[1]?.pressed || false;

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
            localModel.position.add(movement)

            // Adjust y-position based on terrain
            const terrainHeight = getTerrainHeightAt(localModel.position.x, localModel.position.z)
            localModel.position.y = terrainHeight

            // Reposition camera above localModel
            const cameraOffset = new THREE.Vector3(0, 1.7, 0);
            camera.position.copy(localModel.position.clone().add(cameraOffset));

            // Broadcast
            emitMovementIfChanged({
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
                const turnAmount = mouseSensitivity * turnDirection * delta * 100 // Adjusted for better responsiveness
                // Rotate localModel
                if (localModel) {
                    localModel.rotation.y -= turnAmount;
                }
                // Adjust camera rotation accordingly
                yaw = localModel.rotation.y

                // Update camera rotation
                camera.rotation.set(pitch, yaw, 0, 'YXZ')

                // Broadcast orientation
                emitMovementIfChanged({
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

// ------------------------------
// getCameraYaw() - Helper to retrieve camera's yaw
// ------------------------------
function getCameraYaw() {
    const euler = new THREE.Euler()
    euler.setFromQuaternion(camera.quaternion, 'YXZ')
    return euler.y
}

// ------------------------------
// Add `myId` to all emits
// ------------------------------
function emitMovementIfChanged(newState) {
    const newString = JSON.stringify(newState)
    const oldString = lastEmittedState ? JSON.stringify(lastEmittedState) : null

    if (newString !== oldString) {
        newState.id = myId // add myId to payload
        socket.emit('move', newState)
        lastEmittedState = newState
    }
}

// ------------------------------
// Render loop
// ------------------------------

function animate() {
    renderer.setAnimationLoop(() => {
        const delta = clock.getDelta();

        // 1. Update local animations
        if (localMixer) {
            localMixer.update(delta);
        }

        // 2. Update camera orientation based on device orientation data, if enabled
        if (window.isOrientationEnabled) {
            updateCameraOrientation();
        }

        // 3. Handle rendering and movements based on VR availability
        if (renderer.xr.isPresenting) {
            // **VR Mode**

            // Handle VR-specific movements (e.g., joystick input)
            handleVRMovement(delta);

            // Handle teleportation intersections and marker placement
            checkTeleportIntersections();

            // Ensure the camera is correctly positioned above the terrain
            const terrainHeight = getTerrainHeightAt(localModel.position.x, localModel.position.z);
            localModel.position.y = terrainHeight;

            // **Render the scene for VR without post-processing**
            renderer.render(scene, camera);
        } else {
            // **Desktop/Mobile Mode**

            // Make the local model follow the camera's position smoothly, if it exists
            if (localModel) {
                // Ensure the camera is correctly positioned above the terrain
                const terrainHeight = getTerrainHeightAt(localModel.position.x, localModel.position.z);
                localModel.position.y = terrainHeight;

                // Automatically reposition the camera 1.7 units above the closest grid point
                //repositionCameraAboveClosestGridPoint();

                // Optional: Smooth camera movement (if needed)
                // camera.position.lerp(targetPosition, 0.1);
            }

            // Handle desktop-specific movements (e.g., keyboard input)
            moveLocalCharacterDesktop(delta);

            // **Render the scene with post-processing effects**
            composer.render(scene, camera);
        }

        // 4. Update remote players' animations
        Object.values(players).forEach(p => {
            p.mixer.update(delta);
        });

        // 5. Render dynamic terrain points
        renderTerrainPoints();

        // 6. Optionally, handle asynchronous line drawing
        // This can be managed via separate functions or states if needed
    });
}



// ------------------------------
// Update Camera Orientation Based on Device Orientation
// ------------------------------
function updateCameraOrientation() {
    const alphaDeg = window.orientationData.alpha || 0 // 0..360 degrees
    const betaDeg = window.orientationData.beta || 0 // -180..180 degrees

    // Convert to radians
    const alphaRad = THREE.MathUtils.degToRad(alphaDeg)
    const betaRad = THREE.MathUtils.degToRad(betaDeg)

    // Debugging output: show alpha/beta in degrees
    // Optionally, comment out in production
    console.log(
        `Device Orientation - Alpha: ${alphaDeg.toFixed(
            2
        )}°, Beta: ${betaDeg.toFixed(2)}°, Yaw: ${THREE.MathUtils.radToDeg(
            alphaRad
        ).toFixed(2)}°, Pitch: ${THREE.MathUtils.radToDeg(
            betaRad - Math.PI / 2
        ).toFixed(2)}°`
    )

    // Calculate pitch based on beta
    // When beta = 90 degrees, pitch = 0 (device upright)
    const pitchAngle = THREE.MathUtils.clamp(
        betaRad - Math.PI / 2,
        pitchMin, // ~ -1.56 radians (-89.4 degrees)
        pitchMax // ~ +1.56 radians (+89.4 degrees)
    )

    // Yaw is alpha radians
    yaw = alphaRad

    pitch = pitchAngle

    // Update camera rotation
    camera.rotation.set(pitch, yaw, 0, 'YXZ')
}

// ------------------------------
// Load local model
// ------------------------------
function loadLocalModel() {
    // Check if a VR session is active; if so, do not load the local model
    if (renderer.xr.isPresenting) {
        console.log('VR session active. Skipping loading of local model to prevent camera obstruction.')
        return
    }

    const spawnData = loadPositionFromLocalStorage()
    let finalSpawn = spawnData

    if (!finalSpawn) {
        finalSpawn = getRandomSpawnPoint()
        console.log('No saved position found; using random spawn:', finalSpawn)
    } else {
        console.log('Loaded saved position from localStorage:', finalSpawn)
    }
    const loader = new GLTFLoader()
    loader.load(
        modelPath,
        gltf => {
            localModel = gltf.scene
            
            localModel.position.set(finalSpawn.x, terrainHeight || 0, finalSpawn.z)
            localModel.rotation.y = finalSpawn.rotation || 0

            scene.add(localModel)

            localModel.traverse(obj => {
                if (obj.isMesh) obj.castShadow = true
            })

            // Setup localMixer
            localMixer = new THREE.AnimationMixer(localModel)
            gltf.animations.forEach(clip => {
                const action = localMixer.clipAction(clip)
                action.loop = THREE.LoopRepeat
                localActions[clip.name] = action
                if (clip.name === 'idle') action.play()
            })

            // Finally, inform server
            socket.emit('player_joined', {
                x: finalSpawn.x,
                z: finalSpawn.z,
                rotation: finalSpawn.rotation,
                action: 'idle',
                id: myId // include localStorage ID
            })
        },
        undefined,
        err => console.error('Error loading local model:', err)
    )
}

// ------------------------------
// Unload local model
// ------------------------------
function unloadLocalModel() {
    if (localModel) {
        scene.remove(localModel)
        localModel.traverse(obj => {
            if (obj.isMesh) obj.castShadow = false
        })
        localModel = null
        localMixer = null
        localActions = {}
        console.log('Local model unloaded.')
    }
}

// ------------------------------
// Terrain
// ------------------------------
function generateTerrain() {
    const size = terrainSize
    const segments = terrainSegments
    const halfSize = size / 2
    const segmentSize = size / segments

    const distanceRanges = [
        { min: 0, max: size * 0.2, pointSize: 0.02, lineOpacity: 0.0 },
        { min: size * 0.2, max: size * 0.4, pointSize: 0.015, lineOpacity: 0.1 },
        { min: size * 0.4, max: size * 0.5, pointSize: 0.012, lineOpacity: 0.2 },
        { min: size * 0.5, max: size * 0.6, pointSize: 0.01, lineOpacity: 0.4 },
        { min: size * 0.6, max: size * 0.7, pointSize: 0.008, lineOpacity: 0.6 },
        { min: size * 0.7, max: size * 0.8, pointSize: 0.005, lineOpacity: 1.0 }
    ]

    const pointsByRange = []
    const linesByRange = []
    for (let i = 0; i < distanceRanges.length; i++) {
        pointsByRange.push([])
        linesByRange.push([])
    }

    const vertexIndices = []
    for (let i = 0; i <= segments; i++) {
        vertexIndices[i] = []
        for (let j = 0; j <= segments; j++) {
            const x = i * segmentSize - halfSize
            const z = j * segmentSize - halfSize
            const dist = Math.sqrt(x * x + z * z)
            let y = 0

            if (dist <= size * 0.5) {
                if (dist > size * 0.3) {
                    y =
                        Math.pow((dist - size * 0.3) / (halfSize - size * 0.4), 1.5) *
                        2 *
                        (Math.random() * 0.2 + 0.8)
                }

                let rangeIndex = distanceRanges.length - 1
                for (let k = 0; k < distanceRanges.length; k++) {
                    if (dist >= distanceRanges[k].min && dist < distanceRanges[k].max) {
                        rangeIndex = k
                        break
                    }
                }
                pointsByRange[rangeIndex].push(x, y, z)
                vertexIndices[i][j] = {
                    index: pointsByRange[rangeIndex].length / 3 - 1,
                    rangeIndex
                }
            } else {
                vertexIndices[i][j] = undefined
            }
        }
    }

    for (let k = 0; k < distanceRanges.length; k++) {
        const vertices = pointsByRange[k]
        if (vertices.length > 0) {
            const terrainGeometry = new THREE.BufferGeometry()
            terrainGeometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute(vertices, 3)
            )

            const terrainMaterial = new THREE.PointsMaterial({
                color: 0xffffff,
                size: distanceRanges[k].pointSize,
                transparent: true,
                opacity: 0.2
            })

            const terrainPoints = new THREE.Points(terrainGeometry, terrainMaterial)
            scene.add(terrainPoints)
        }

        const lineVertices = linesByRange[k]
        if (lineVertices.length > 0 && distanceRanges[k].lineOpacity > 0) {
            const lineGeometry = new THREE.BufferGeometry()
            lineGeometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute(lineVertices, 3)
            )

            const lineMaterial = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: distanceRanges[k].lineOpacity * 0.2
            })

            const terrainLines = new THREE.LineSegments(lineGeometry, lineMaterial)
            scene.add(terrainLines)
        }
    }
}

// ------------------------------
// setLocalAction: crossfade
// ------------------------------
function setLocalAction(name, direction = 'forward') {
    if (currentAction !== name) {
        if (localActions[currentAction]) {
            localActions[currentAction].fadeOut(0.5)
        }
        if (localActions[name]) {
            localActions[name].reset().fadeIn(0.5).play()
            if (name === 'walk' || name === 'run') {
                localActions[name].timeScale = direction === 'forward' ? 1 : -1
                if (direction === 'backward') {
                    localActions[name].time = localActions[name].getClip().duration
                } else {
                    localActions[name].time = 0
                }
            } else {
                localActions[name].timeScale = 1
            }
        }
        currentAction = name
    } else {
        if (name === 'walk' || name === 'run') {
            localActions[name].timeScale = direction === 'forward' ? 1 : -1
            if (direction === 'backward') {
                localActions[name].time =
                    localActions[name].getClip().duration - localActions[name].time
            } else {
                localActions[name].time = 0
            }
        }
    }
}

// ------------------------------
// Sockets
// ------------------------------
function setupSocketEvents() {
    socket.on('init', data => {
        console.log('[Socket] init => received init data:', data)

        // We store the ID the server gave us.
        myId = data.id

        // Update players with the full dictionary from the server
        updatePlayers(data.players)
    })

    socket.on('state_update_all', data => {
        updatePlayers(data)
        lastState = { ...data }
    })

    socket.on('new_player', data => {
        console.log(`[Socket] new_player => Data:`, data)

        // If the server calls it `localId`, then we match it to `myId`
        if (data.localId === myId) {
            // This is our own local ID; skip remote creation
            return
        }

        console.log(
            `[Socket] new_player => Creating or updating remote ID: ${data.localId}`
        )
        addOrUpdatePlayer(data.localId, data)
    })

    socket.on('state_update', data => {
        const incomingString = JSON.stringify(data)
        const lastString = lastStateData ? JSON.stringify(lastStateData) : null

        // Only log if changed
        if (incomingString !== lastString) {
            console.log('[Socket] state_update => changed data from server:', data)
            lastStateData = data
        } else {
            // Data is unchanged; ignoring.
        }
    })

    socket.on('player_disconnected', id => {
        removeRemotePlayer(id)
    })

    // Audio events
    socket.on('start_audio', data => {
        const { id } = data
        addRemoteAudioStream(id)
    })

    socket.on('stop_audio', data => {
        const { id } = data
        removeRemoteAudioStream(id)
    })

    socket.on('audio_stream', data => {
        const { id, audio } = data
        receiveAudioStream(id, audio)
    })
}

function addOrUpdatePlayer(id, data) {
    // Should skip if it's the local player's ID
    if (id === myId) {
        console.warn(`Skipping addOrUpdatePlayer for local ID = ${id}`)
        return
    }

    if (!players[id]) {
        createRemotePlayer(id, data)
    } else {
        updateRemotePlayer(id, data)
    }
}

function createRemotePlayer(id, data) {
    if (players[id] || loadingPlayers.has(id)) {
        console.warn(
            `Skipping creation for player ${id}. Already exists or is loading.`
        )
        return
    }
    if (id === myId) {
        return
    }
    loadingPlayers.add(id)

    const loader = new GLTFLoader()
    loader.load(
        modelPath,
        gltf => {
            const remoteModel = gltf.scene
            const terrainHeight = getTerrainHeightAt(localModel.position.x, localModel.position.z);
            remoteModel.position.set(data.x, terrainHeight, data.z)
            remoteModel.rotation.y = data.rotation
            remoteModel.castShadow = true

            const remoteMixer = new THREE.AnimationMixer(remoteModel)
            const remoteActions = {}
            gltf.animations.forEach(clip => {
                remoteActions[clip.name] = remoteMixer.clipAction(clip)
            })
            if (remoteActions['idle']) {
                remoteActions['idle'].play()
            }

            players[id] = {
                model: remoteModel,
                mixer: remoteMixer,
                actions: remoteActions,
                position: new THREE.Vector3(data.x, 0, data.z),
                rotation: data.rotation,
                currentAction: 'idle',
                initialized: true
            }
            scene.add(remoteModel)
            loadingPlayers.delete(id)
        },
        undefined,
        err => {
            console.error(`Error loading model for player ${id}:`, err)
            loadingPlayers.delete(id)
        }
    )
}

// 1) Normalize an angle to [0..2π)
function normalizeAngle(angle) {
    angle = angle % (2 * Math.PI)
    if (angle < 0) {
        angle += 2 * Math.PI
    }
    return angle
}

// 2) Lerp angles using the shortest path
function lerpAngle(currentAngle, targetAngle, alpha) {
    currentAngle = normalizeAngle(currentAngle)
    targetAngle = normalizeAngle(targetAngle)

    let diff = targetAngle - currentAngle
    if (diff > Math.PI) {
        diff -= 2 * Math.PI
    } else if (diff < -Math.PI) {
        diff += 2 * Math.PI
    }
    const newAngle = currentAngle + diff * alpha
    return normalizeAngle(newAngle)
}

// 3) updateRemotePlayer
function updateRemotePlayer(id, data) {
    const player = players[id]
    if (!player) return

    if (!player.initialized) {
        const terrainHeight = getTerrainHeightAt(localModel.position.x, localModel.position.z);
        player.model.position.set(data.x, terrainHeight, data.z)
        player.model.rotation.y = data.rotation
        player.initialized = true
        return
    }

    player.position.set(data.x, 0, data.z)
    player.model.position.lerp(player.position, 0.1)

    const currentAngle = player.model.rotation.y
    const targetAngle = data.rotation
    player.model.rotation.y = lerpAngle(currentAngle, targetAngle, 0.1)

    if (remoteAudioStreams[id]) {
        remoteAudioStreams[id].positionalAudio.position.copy(player.model.position)
    }

    const distMoved = player.position.distanceTo(player.model.position)
    const isMoving = distMoved > 0.01
    const movementDir = player.position
        .clone()
        .sub(player.model.position)
        .normalize()
    const forwardDir = new THREE.Vector3(0, 0, 1).applyQuaternion(
        player.model.quaternion
    )
    const isForward = movementDir.dot(forwardDir) > 0

    let action = 'idle'
    if (isMoving) {
        action = distMoved > 0.5 ? 'run' : 'walk'
    }

    if (player.currentAction !== action) {
        if (player.actions[player.currentAction]) {
            player.actions[player.currentAction].fadeOut(0.5)
        }
        if (player.actions[action]) {
            player.actions[action].reset().fadeIn(0.5).play()
            if (action === 'walk' || action === 'run') {
                player.actions[action].timeScale = isForward ? 1 : -1
            }
        }
        player.currentAction = action
    }
}

function removeRemotePlayer(id) {
    if (players[id]) {
        scene.remove(players[id].model)
        delete players[id]
    }
    removeRemoteAudioStream(id)
}

function updatePlayers(playersData) {
    Object.keys(playersData).forEach(id => {
        if (playersData[id].localId === myId) return
        addOrUpdatePlayer(id, playersData[id])
    })
    Object.keys(players).forEach(id => {
        if (!playersData[id]) {
            removeRemotePlayer(id)
        }
    })
}

// ------------------------------
// Audio streaming
// ------------------------------
function handleUserInteraction() {
    if (listener.context.state === 'suspended') {
        listener.context
            .resume()
            .then(() => {
                console.log('AudioContext resumed on user interaction.')
            })
            .catch(err => {
                console.error('Error resuming AudioContext:', err)
            })
    }
    document.removeEventListener('click', handleUserInteraction)
    document.removeEventListener('keydown', handleUserInteraction)
}

async function startBroadcast() {
    if (localStream) return
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        })
        mediaStreamSource = listener.context.createMediaStreamSource(localStream)

        processor = listener.context.createScriptProcessor(4096, 1, 1)
        mediaStreamSource.connect(processor)
        processor.connect(listener.context.destination)

        processor.onaudioprocess = e => {
            const inputData = e.inputBuffer.getChannelData(0)
            const buffer = new Int16Array(inputData.length)
            for (let i = 0; i < inputData.length; i++) {
                buffer[i] = inputData[i] * 32767
            }
            // Include myId
            socket.emit('audio_stream', {
                id: myId,
                audio: buffer.buffer
            })
        }

        socket.emit('start_audio', { id: myId }) // Include myId
        console.log('Started broadcasting audio.')
    } catch (err) {
        console.error('Error accessing microphone:', err)
    }
}

function stopBroadcast() {
    if (!localStream) return
    if (processor) {
        processor.disconnect()
        processor.onaudioprocess = null
        processor = null
    }
    if (mediaStreamSource) {
        mediaStreamSource.disconnect()
        mediaStreamSource = null
    }
    localStream.getTracks().forEach(track => track.stop())
    localStream = null
    socket.emit('stop_audio', { id: myId }) // Include myId
    console.log('Stopped broadcasting audio.')
}

function addRemoteAudioStream(id) {
    if (!listener.context) {
        console.warn(
            'AudioContext not initialized. Cannot add remote audio stream.'
        )
        return
    }
    const player = players[id]
    if (!player) {
        console.warn(`Player with ID ${id} not found.`)
        return
    }
    if (remoteAudioStreams[id]) return

    const positionalAudio = new THREE.PositionalAudio(listener)
    positionalAudio.setRefDistance(20)
    positionalAudio.setVolume(1.0)
    player.model.add(positionalAudio)
    positionalAudio.play()

    remoteAudioStreams[id] = { positionalAudio }
}

function removeRemoteAudioStream(id) {
    const remoteAudio = remoteAudioStreams[id]
    if (remoteAudio) {
        remoteAudio.positionalAudio.stop()
        remoteAudio.positionalAudio.disconnect()
        remoteAudio.positionalAudio = null
        delete remoteAudioStreams[id]
    }
}

function receiveAudioStream(id, audioBuffer) {
    if (!listener.context) {
        console.warn('AudioContext not initialized. Cannot receive audio stream.')
        return
    }
    const remoteAudio = remoteAudioStreams[id]
    if (!remoteAudio) {
        console.warn(`Received audio data from ${id} before audio stream started.`)
        return
    }

    const int16 = new Int16Array(audioBuffer)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32767
    }
    const buffer = listener.context.createBuffer(
        1,
        float32.length,
        listener.context.sampleRate
    )
    buffer.copyToChannel(float32, 0, 0)

    const bufferSource = listener.context.createBufferSource()
    bufferSource.buffer = buffer
    bufferSource.connect(remoteAudio.positionalAudio.gain)
    bufferSource.start()

    bufferSource.onended = () => {
        bufferSource.disconnect()
    }
}

// ------------------------------
// Utility
// ------------------------------
function getRandomSpawnPoint() {
    const x = (Math.random() - 0.5) * 50
    const z = (Math.random() - 0.5) * 50
    const rotation = Math.random() * Math.PI * 2
    return { x, z, rotation }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
}

// ------------------------------
// Permission Handling
// ------------------------------

// Check Permissions and Initialize Listeners
function checkPermissions() {
    if (window.appPermissions) {
        const { motionGranted, orientationGranted, locationGranted } = window.appPermissions
        console.log('Accessing Global Permissions:', window.appPermissions)

        // Modify behavior based on permissions
        if (motionGranted) {
            console.log('Motion permissions granted.')
            enableMotionFeatures()
        } else {
            console.log('Motion permissions denied.')
            disableMotionFeatures()
            createPermissionOverlay('Motion', requestMotionPermission)
        }

        if (orientationGranted) {
            console.log('Orientation permissions granted.')
            enableOrientationFeatures()
        } else {
            console.log('Orientation permissions denied.')
            disableOrientationFeatures()
            createPermissionOverlay('Orientation', requestOrientationPermission)
        }

        if (locationGranted) {
            console.log('Location permissions granted.')
            initializeLocationFeatures()
        } else {
            console.log('Location permissions denied.')
            disableLocationFeatures()
            createPermissionOverlay('Location', requestLocationPermission)
        }

        // Initialize sensor listeners after checking permissions
        initializeSensorListeners()
    } else {
        console.log('Permissions not yet set.')
        // Optionally, you can create a generic overlay prompting the user to grant all permissions
        createGenericPermissionOverlay()
    }
}

// Example functions to enable/disable features based on permissions
function enableMotionFeatures() {
    // Add or activate motion-related event listeners or controls
    if (window.appPermissions.motionGranted) {
        window.addEventListener('devicemotion', handleMotion)
    }
}

function disableMotionFeatures() {
    // Remove or deactivate motion-related event listeners or controls
    window.removeEventListener('devicemotion', handleMotion)
}

function enableOrientationFeatures() {
    // Enable orientation-specific functionalities
    if (window.appPermissions.orientationGranted) {
        window.addEventListener('deviceorientation', handleOrientation)
    }
}

function disableOrientationFeatures() {
    // Disable orientation-specific functionalities
    window.removeEventListener('deviceorientation', handleOrientation)
}

function initializeLocationFeatures() {
    // Initialize features that rely on location data
    console.log('Initializing location-based features.')
}

function disableLocationFeatures() {
    // Disable or adjust features that rely on location data
    console.log('Disabling location-based features.')
}

// Listen for changes in permissions
window.addEventListener('appPermissionsChanged', () => {
    checkPermissions()
})

// ------------------------------
// Permission Overlay Management
// ------------------------------

/**
 * Creates an overlay prompting the user to grant a specific permission.
 * @param {string} permissionName - The name of the permission (e.g., 'Motion').
 * @param {Function} requestPermissionFunc - The function to call when the user clicks to grant permission.
 */
function createPermissionOverlay(permissionName, requestPermissionFunc) {
    // Check if an overlay for this permission already exists
    if (document.getElementById(`${permissionName}-permission-overlay`)) return

    // Create overlay elements
    const overlay = document.createElement('div')
    overlay.id = `${permissionName}-permission-overlay`
    overlay.className = 'permission-overlay'

    const message = document.createElement('div')
    message.className = 'permission-message'
    message.innerHTML = `Press to enable ${permissionName} permission`

    const button = document.createElement('button')
    button.className = 'permission-button'
    button.innerText = `Enable ${permissionName}`
    button.addEventListener('click', async () => {
        await requestPermissionFunc()
        // After attempting to request permission, re-check permissions
        checkPermissions()
    })

    overlay.appendChild(message)
    overlay.appendChild(button)
    document.body.appendChild(overlay)
}

/**
 * Removes the overlay for a specific permission.
 * @param {string} permissionName - The name of the permission (e.g., 'Motion').
 */
function removePermissionOverlay(permissionName) {
    const overlay = document.getElementById(`${permissionName}-permission-overlay`)
    if (overlay) {
        document.body.removeChild(overlay)
    }
}

/**
 * Creates a generic overlay prompting the user to grant all permissions.
 * Optional: Customize as needed.
 */
function createGenericPermissionOverlay() {
    // Implement if you want a generic overlay for all permissions not set yet
    // For this scenario, it's optional and can be left empty or removed
}

// ------------------------------
// Permission Request Functions
// ------------------------------

/**
 * Requests Motion permission (for DeviceMotionEvent).
 */
async function requestMotionPermission() {
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
            const response = await DeviceMotionEvent.requestPermission()
            if (response === 'granted') {
                window.appPermissions.motionGranted = true
                console.log('Motion permission granted.')
                removePermissionOverlay('Motion')
                enableMotionFeatures()
            } else {
                console.log('Motion permission denied.')
            }
        } catch (error) {
            console.error('Error requesting Motion permission:', error)
        }
    } else {
        // For non-iOS devices or browsers that don't require permission
        window.appPermissions.motionGranted = true
        console.log('Motion permission assumed granted.')
        removePermissionOverlay('Motion')
        enableMotionFeatures()
    }
}

/**
 * Requests Orientation permission (for DeviceOrientationEvent).
 */
async function requestOrientationPermission() {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const response = await DeviceOrientationEvent.requestPermission()
            if (response === 'granted') {
                window.appPermissions.orientationGranted = true
                console.log('Orientation permission granted.')
                removePermissionOverlay('Orientation')
                enableOrientationFeatures()
            } else {
                console.log('Orientation permission denied.')
            }
        } catch (error) {
            console.error('Error requesting Orientation permission:', error)
        }
    } else {
        // For non-iOS devices or browsers that don't require permission
        window.appPermissions.orientationGranted = true
        console.log('Orientation permission assumed granted.')
        removePermissionOverlay('Orientation')
        enableOrientationFeatures()
    }
}

/**
 * Requests Location permission (for Geolocation).
 */
async function requestLocationPermission() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            console.error("Geolocation is not supported by this browser.")
            resolve(false)
            return
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude } = position.coords
                window.latitude = latitude
                window.longitude = longitude
                const locationElement = document.getElementById("location")
                if (locationElement) {
                    locationElement.innerHTML = `Location: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
                }
                window.appPermissions.locationGranted = true
                console.log('Location permission granted.')
                removePermissionOverlay('Location')
                initializeLocationFeatures()
                resolve(true)
            },
            (error) => {
                console.error("Error getting location:", error)
                if (error.code === error.PERMISSION_DENIED) {
                    alert("Location permissions denied. Location data will be unavailable.")
                    const locationElement = document.getElementById("location")
                    if (locationElement) {
                        locationElement.innerHTML = `Location: Permission Denied`
                    }
                } else {
                    alert("Unable to retrieve location data.")
                }
                window.appPermissions.locationGranted = false
                resolve(false)
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 5000
            }
        )
    })
}
// ------------------------------
// Swipe Gesture Controls Integration
// ------------------------------
// This section handles mapping swipe gestures to WASD controls
// The swipe detection is handled in index.html, but we need to listen to the corresponding key events here

// Function to handle camera orientation based on device orientation data
// This is already handled in the animate loop by updating camera.rotation

// Function to handle swipe gestures mapped to WASD
// Swipes are translated into keydown and keyup events which are already handled by the existing key event listeners

// No additional code needed here since swipe gestures trigger key events that are handled by the existing key event listeners

// app.js

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js'
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js'
import Stats from 'three/addons/libs/stats.module.js';

import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { io } from 'https://cdn.socket.io/4.4.1/socket.io.esm.min.js'
// import './terrain.js'
import SimplexNoise from 'https://cdn.jsdelivr.net/npm/simplex-noise@3.0.0/dist/esm/simplex-noise.min.js'
import SunCalc from 'suncalc';

// ------------------------------
// Model path (public vs root)
// ------------------------------
let modelPath;
let fontPath;

if (window.location.pathname.includes('/public/')) {
  modelPath = '/public/Xbot.glb';
  fontPath = '/public/uno.ttf';
} else {
  modelPath = '/Xbot.glb';
  fontPath = '/uno.ttf';
}

// Log the paths
console.log(`Model Path: ${modelPath}`);
console.log(`Font Path: ${fontPath}`);

// Inject the font path into CSS
const styleSheet = new CSSStyleSheet();
styleSheet.insertRule(`
  @font-face {
    font-family: 'Uno';
    src: url('${fontPath}') format('truetype');
    font-weight: normal;
    font-style: normal;
  }
`);

// Attach the stylesheet globally to document
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];
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
// Mouse sensitivity (radians per pixel)
const mouseSensitivity = 0.002; // Adjust as needed

// Pitch limits to prevent camera flipping
const pitchMin = -Math.PI / 2 + 0.1; // Slightly above -90 degrees
const pitchMax = Math.PI / 2 - 0.1;  // Slightly below +90 degrees

// VR Teleport
let baseReferenceSpace = null
let markerMesh
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
const runSpeed = 107 // Adjusted to a realistic running speed

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



class DayNightCycle {
  constructor(scene, options = {}) {
    this.scene = scene;

    // Default options (can be overridden)
    this.options = {
      skyScale: 450000,
      directionalLightColor: 0xffffff,
      directionalLightIntensityDay: 1,
      directionalLightIntensityNight: 0.1,
      directionalLightPosition: new THREE.Vector3(0, 200, -200),
      directionalLightTarget: new THREE.Vector3(-5, 0, 0),
      shadowMapSize: new THREE.Vector2(1024, 1024),
      skyTurbidity: 10,
      skyRayleigh: 3,
      skyMieCoefficient: 0.005,
      skyMieDirectionalG: 0.6,
      ambientLightColor: 0xffffff,
      ambientLightIntensityDay: 0.8,
      ambientLightIntensityNight: 0.2,
      transitionSpeed: 0.01, // Speed of transitions
      updateInterval: 60 * 1000, // Update every minute
    };

    Object.assign(this.options, options);

    // Initialize components
    this.initDirectionalLight();
    this.initSky();
    this.initAmbientLight();

    // Initialize location and time-dependent data
    this.latitude = null;
    this.longitude = null;
    this.sunrise = null;
    this.sunset = null;

    // For smooth transitions
    this.currentAmbientIntensity = this.options.ambientLightIntensityNight;
    this.currentDirLightIntensity = this.options.directionalLightIntensityNight;

    // Start the initialization process
    this.initLocation();
  }

  initLocation() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          this.latitude = position.coords.latitude;
          this.longitude = position.coords.longitude;
          this.calculateSunTimes();
          this.updateSunPosition(); // Set initial sun position based on current time and location

          // Optionally, set an interval to update sun times daily
          setInterval(() => {
            this.calculateSunTimes();
          }, 24 * 60 * 60 * 1000); // Every 24 hours
        },
        (error) => {
          console.error('Geolocation error:', error);
          // Fallback to default sunrise and sunset times if location is unavailable
          this.latitude = 0;
          this.longitude = 0;
          this.setDefaultSunTimes();
          this.updateSunPosition();
        }
      );
    } else {
      console.error('Geolocation not supported.');
      // Fallback to default sunrise and sunset times if geolocation is not supported
      this.latitude = 0;
      this.longitude = 0;
      this.setDefaultSunTimes();
      this.updateSunPosition();
    }
  }

  setDefaultSunTimes() {
    // Default sunrise and sunset times (e.g., 6 AM and 6 PM)
    const now = new Date();
    this.sunrise = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0);
    this.sunset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
  }

  calculateSunTimes() {
    if (!this.latitude || !this.longitude) {
      console.warn('Latitude and Longitude are not set.');
      this.setDefaultSunTimes();
      return;
    }

    const now = new Date();
    const times = SunCalc.getTimes(now, this.latitude, this.longitude);

    this.sunrise = times.sunrise;
    this.sunset = times.sunset;

    // Optional: Log the times for debugging
    console.log('Sunrise:', this.sunrise);
    console.log('Sunset:', this.sunset);
  }

  initDirectionalLight() {
    // Create Directional Light
    this.dirLight = new THREE.DirectionalLight(
      this.options.directionalLightColor,
      this.options.directionalLightIntensityNight
    );
    this.dirLight.position.copy(this.options.directionalLightPosition);
    this.dirLight.castShadow = true;
    this.dirLight.target.position.copy(this.options.directionalLightTarget);
    this.dirLight.shadow.mapSize.copy(this.options.shadowMapSize);
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target); // Ensure the target is added to the scene
  }

  initSky() {
    // Initialize Sky
    this.sky = new Sky();
    this.sky.scale.setScalar(this.options.skyScale);
    this.scene.add(this.sky);

    // Configure Sky Parameters
    this.skyUniforms = this.sky.material.uniforms;

    this.skyUniforms['turbidity'].value = this.options.skyTurbidity;
    this.skyUniforms['rayleigh'].value = this.options.skyRayleigh;
    this.skyUniforms['mieCoefficient'].value = this.options.skyMieCoefficient;
    this.skyUniforms['mieDirectionalG'].value = this.options.skyMieDirectionalG;

    this.sun = new THREE.Vector3();
    this.skyUniforms['sunPosition'].value.copy(this.sun);

  }

  initAmbientLight() {
    // Add Ambient Light
    this.ambientLight = new THREE.AmbientLight(
      this.options.ambientLightColor,
      this.options.ambientLightIntensityNight
    );
    this.scene.add(this.ambientLight);
  }

  updateSunPosition() {
    if (!this.sunrise || !this.sunset) {
      console.warn('Sunrise and sunset times are not set.');
      return;
    }

    const now = new Date();

    // Determine if it's day or night
    const isDay = now >= this.sunrise && now < this.sunset;

    let elevation;
    let azimuth;

    if (isDay) {
      // Calculate the progress of the day (0 at sunrise, 1 at sunset)
      const dayDuration = (this.sunset - this.sunrise) / (1000 * 60 * 60); // Duration in hours
      const timeSinceSunrise = (now - this.sunrise) / (1000 * 60 * 60); // Hours since sunrise
      const dayProgress = timeSinceSunrise / dayDuration; // 0 to 1

      elevation = dayProgress * 90; // From 0° (horizon) to 90° (zenith)
      azimuth = 180; // Adjust as needed for sun's path

      // Smoothly interpolate ambient light intensity
      this.currentAmbientIntensity += (this.options.ambientLightIntensityDay * dayProgress - this.currentAmbientIntensity) * this.options.transitionSpeed;
      this.ambientLight.intensity = THREE.MathUtils.clamp(this.currentAmbientIntensity, this.options.ambientLightIntensityNight, this.options.ambientLightIntensityDay);

      // Smoothly interpolate directional light intensity
      this.currentDirLightIntensity += (this.options.directionalLightIntensityDay - this.currentDirLightIntensity) * this.options.transitionSpeed;
      this.dirLight.intensity = THREE.MathUtils.clamp(this.currentDirLightIntensity, this.options.directionalLightIntensityNight, this.options.directionalLightIntensityDay);
    } else {
      // Nighttime
      elevation = 0; // Sun below the horizon
      azimuth = 180; // Adjust for moon or other celestial bodies if desired

      // Smoothly interpolate ambient light intensity
      this.currentAmbientIntensity += (this.options.ambientLightIntensityNight - this.currentAmbientIntensity) * this.options.transitionSpeed;
      this.ambientLight.intensity = THREE.MathUtils.clamp(this.currentAmbientIntensity, this.options.ambientLightIntensityNight, this.options.ambientLightIntensityDay);

      // Smoothly interpolate directional light intensity
      this.currentDirLightIntensity += (this.options.directionalLightIntensityNight - this.currentDirLightIntensity) * this.options.transitionSpeed;
      this.dirLight.intensity = THREE.MathUtils.clamp(this.currentDirLightIntensity, this.options.directionalLightIntensityNight, this.options.directionalLightIntensityDay);
    }

    // Convert spherical coordinates to Cartesian coordinates
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);

    this.sun.setFromSphericalCoords(1, phi, theta);

    // Update Sky's sun position
    this.skyUniforms['sunPosition'].value.copy(this.sun);

    // Update Directional Light position based on sun
    const distance = 200; // Adjust as needed
    this.dirLight.position.set(
      this.sun.x * distance,
      this.sun.y * distance,
      this.sun.z * distance
    );
    this.dirLight.target.position.copy(this.options.directionalLightTarget);
    this.dirLight.target.updateMatrixWorld();
  }

  update() {
    // Update sun position periodically
    this.updateSunPosition();
  }
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

  //const effectFilm = new FilmPass(0.35)
  //composer.addPass(effectFilm)

  //const effect2 = new ShaderPass(RGBShiftShader)
  //effect2.uniforms['amount'].value = 0.0015
  //composer.addPass(effect2)

  //const effect3 = new OutputPass()
  //composer.addPass(effect3)

  // Setup VR controllers
  setupVRControllers()

  // Generate terrain
  //initializeTerrain();
  loadLocalModel()

  // Keyboard events (Desktop)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)

  // Enable pointer lock (Desktop)
  enablePointerLock()

  // Window resize
  window.addEventListener('resize', onWindowResize, false);

  // Socket setup
  setupSocketEvents()

  // Clock for animations
  clock = new THREE.Clock()

  // Audio context on user interaction
  document.addEventListener('click', handleUserInteraction, { once: true })
  document.addEventListener('keydown', handleUserInteraction, { once: true })

  // Save local position on unload
  window.addEventListener('beforeunload', savePositionToLocalStorage)

  // Call the geolocation initializer
  //generateTerrain()

  // Check and initialize sensor listeners based on permissions
  checkPermissions()
}

// Initialize DayNightCycle
const dayNightCycle = new DayNightCycle(scene, {
  skyTurbidity: 10,
  skyRayleigh: 10,
  skyMieCoefficient: 0.005,
  skyMieDirectionalG: 0.6,
  ambientLightIntensityDay: 0.8,
  ambientLightIntensityNight: 0.2,
  directionalLightIntensityDay: 1,
  directionalLightIntensityNight: 0.1,
  transitionSpeed: 0.05, // Faster transition for demonstration
});

// Ensure Three.js is included in your project
// <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>

// Flag to prevent multiple initializations
let terrainInitialized = false

// Expose elevation data to the window object
window.elevationData = []

// Terrain Point Cloud Objects
let terrainGeometry = null
let terrainMaterial = null
let terrainPointCloud = null
let terrainLineSegments = null // Line segments for connecting points
let terrainMesh = null // Mesh surface for the terrain
let terrainMeshWire = null // Wireframe mesh surface for the terrain

const gridSizeMeters = 500
const gridResolution = 100

// Render Control
const POINTS_BATCH_SIZE = 100 // Number of points to render per frame
let nextPointIndex = 0 // Tracks the next point to fill in the buffer
const totalPoints = gridResolution * gridResolution

// Terrain scale multiplier
const scaleMultiplier = 1 // Default scale (1/100)

// Local Storage Key
const LS_TERRAIN_POINTS_KEY = 'terrainPoints'

// Reference elevation for normalization
let referenceElevation = window.location?.elevation || 0

// Grid Boundaries
let gridMinLat = null
let gridMaxLat = null
let gridMinLon = null
let gridMaxLon = null

// Previous Location for Movement Detection
let previousLocation = {
  latitude: null,
  longitude: null
}

// Origin for coordinate mapping (fixed at initial location)
let originLatitude = null
let originLongitude = null



/**
 * Generates a grid of geographic points around a center location.
 * Ensures exactly gridResolution^2 points are generated.
 * @param {Object} center - Object with latitude and longitude.
 * @param {number} gridSizeMeters - Size of the grid in meters.
 * @param {number} gridResolution - Number of points per axis.
 * @returns {Array} Array of point objects with latitude and longitude.
 */
function generateGrid(center, gridSizeMeters, gridResolution) {
  const points = []
  const stepMeters = (2 * gridSizeMeters) / (gridResolution - 1) // Adjust step to fit grid exactly

  const deltaLat = stepMeters / 111000
  const deltaLon =
    stepMeters / (111000 * Math.cos(THREE.MathUtils.degToRad(center.latitude)))

  for (let i = 0; i < gridResolution; i++) {
    for (let j = 0; j < gridResolution; j++) {
      const latOffset = (i - (gridResolution - 1) / 2) * deltaLat
      const lonOffset = (j - (gridResolution - 1) / 2) * deltaLon

      points.push({
        latitude: center.latitude + latOffset,
        longitude: center.longitude + lonOffset
      })
    }
  }

  return points
}

/**
 * Saves a batch of points to localStorage.
 * Ensures that the total saved points do not exceed totalPoints.
 * @param {Array} pointsBatch - Array of point objects to save.
 */
function savePointsToLocalStorage(pointsBatch) {
  let savedPoints =
    JSON.parse(localStorage.getItem(LS_TERRAIN_POINTS_KEY)) || []

  // Calculate available space
  const availableSpace = totalPoints - savedPoints.length
  if (availableSpace <= 0) {
    console.warn('LocalStorage is full. Cannot save more terrain points.')
    return
  }

  // Limit pointsBatch to availableSpace
  const pointsToSave = pointsBatch.slice(0, availableSpace)
  if (pointsBatch.length > pointsToSave.length) {
    console.warn(
      `Only ${pointsToSave.length} out of ${pointsBatch.length} points were saved to localStorage to prevent overflow.`
    )
  }

  savedPoints = savedPoints.concat(pointsToSave)

  try {
    localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(savedPoints))
    console.log(`Saved ${pointsToSave.length} points to localStorage.`)
  } catch (e) {
    console.error('Failed to save terrain points to localStorage:', e)
  }
}

/**
 * Loads saved points from localStorage.
 * Ensures that no more than totalPoints are loaded.
 * @returns {Array} Array of saved point objects.
 */
function loadPointsFromLocalStorage() {
  let savedPoints = JSON.parse(localStorage.getItem(LS_TERRAIN_POINTS_KEY)) || []

  if (savedPoints.length > totalPoints) {
    console.warn(
      `LocalStorage has ${savedPoints.length} points, which exceeds the expected ${totalPoints}. Truncating excess points.`
    )
    savedPoints = savedPoints.slice(0, totalPoints)
    localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(savedPoints))
  }

  return savedPoints
}

/**
 * Fetches elevation data for a grid of geographic points.
 * Limits the number of points fetched to prevent exceeding totalPoints.
 * @param {Array} points - Array of points with latitude and longitude.
 * @param {string} units - 'Meters' or 'Feet'.
 * @param {number} concurrency - Number of concurrent fetches.
 * @param {number} retries - Number of retries for failed fetches.
 * @returns {Promise<void>}
 */
async function fetchElevationGrid(
  points,
  units = 'Meters',
  concurrency = 10,
  retries = 3
) {
  let index = 0

  /**
   * Fetch elevation with retry logic.
   * @param {number} longitude
   * @param {number} latitude
   * @param {number} attempt
   * @returns {number|null} Elevation value or null if failed.
   */
  const fetchWithRetry = async (longitude, latitude, attempt = 1) => {
    const elevation = await fetchElevation(longitude, latitude, units)
    if (elevation === null && attempt <= retries) {
      console.warn(
        `Retrying elevation fetch for (${latitude.toFixed(
          5
        )}, ${longitude.toFixed(5)}) - Attempt ${attempt + 1}`
      )
      return await fetchWithRetry(longitude, latitude, attempt + 1)
    }
    return elevation
  }

  /**
   * Worker function to process grid points.
   */
  const worker = async () => {
    while (true) {
      let currentIndex
      // Atomically get the next index
      if (index >= points.length) {
        break
      }
      currentIndex = index++
      const point = points[currentIndex]
      const elevation = await fetchWithRetry(point.longitude, point.latitude, 1)
      if (elevation !== null) {
        const elevationPoint = {
          latitude: point.latitude,
          longitude: point.longitude,
          elevation: elevation
        }
        window.elevationData.push(elevationPoint)
        console.log(
          `Lat: ${elevationPoint.latitude.toFixed(
            5
          )}, Lon: ${elevationPoint.longitude.toFixed(5)}, Elevation: ${elevationPoint.elevation
          } meters`
        )
      } else {
        console.log(
          `Lat: ${point.latitude.toFixed(5)}, Lon: ${point.longitude.toFixed(
            5
          )}, Elevation: Fetch Failed`
        )
      }
    }
  }

  // Initialize workers
  const workersArray = []
  for (let i = 0; i < concurrency; i++) {
    workersArray.push(worker())
  }

  // Wait for all workers to complete
  await Promise.all(workersArray)

  console.log('All elevation data fetched.')
}

/**
 * Fetches elevation data for a single geographic point from the USGS EPQS API.
 * @param {number} longitude
 * @param {number} latitude
 * @param {string} units - 'Meters' or 'Feet'.
 * @returns {number|null} Elevation value or null if failed.
 */
async function fetchElevation(longitude, latitude, units = 'Meters') {
  const endpoint = 'https://epqs.nationalmap.gov/v1/json'
  const url = `${endpoint}?x=${longitude}&y=${latitude}&units=${units}&output=json`

  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Elevation API error: ${response.statusText}`)
    }
    const data = await response.json()
    if (data && data.value !== undefined) {
      return data.value // Elevation in the specified units
    } else {
      throw new Error('Invalid elevation data received.')
    }
  } catch (error) {
    console.error(
      `Failed to fetch elevation for (${latitude.toFixed(
        5
      )}, ${longitude.toFixed(5)}):`,
      error
    )
    return null // Indicate failure
  }
}

// Listen for the custom 'locationUpdated' event
window.addEventListener('locationUpdated', async () => {
  const { latitude, longitude } = window

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    console.error(
      'Latitude and Longitude must be set on the window object as numbers.'
    )
    return
  }

  if (!terrainInitialized) {
    console.log(
      `Initializing terrain for Latitude: ${latitude}, Longitude: ${longitude}`
    )
    terrainInitialized = true

    try {
      // Set origin at initial location
      originLatitude = latitude
      originLongitude = longitude

      const gridPoints = generateGrid(
        { latitude, longitude },
        gridSizeMeters,
        gridResolution
      )

      console.log(`Generated ${gridPoints.length} grid points.`)

      // Initialize Terrain Point Cloud
      initializeTerrainPointCloud()

      // Set initial grid boundaries
      gridMinLat = latitude - (gridSizeMeters / 111000)
      gridMaxLat = latitude + (gridSizeMeters / 111000)
      gridMinLon = longitude - (gridSizeMeters / (111000 * Math.cos(THREE.MathUtils.degToRad(latitude))))
      gridMaxLon = longitude + (gridSizeMeters / (111000 * Math.cos(THREE.MathUtils.degToRad(latitude))))

      // Load saved points from localStorage
      const savedPoints = loadPointsFromLocalStorage()
      if (savedPoints.length > 0) {
        console.log(`Loaded ${savedPoints.length} points from localStorage.`)
        populateTerrainFromSavedPoints(savedPoints)
        nextPointIndex = savedPoints.length
      }

      // Fetch remaining elevation data
      const remainingSpace = totalPoints - savedPoints.length
      if (remainingSpace > 0) {
        const remainingPoints = gridPoints.slice(nextPointIndex, nextPointIndex + remainingSpace)
        if (remainingPoints.length > 0) {
          await fetchElevationGrid(remainingPoints, 'Meters', 10, 3)
          console.log('Started fetching elevation data for remaining points.')
          // After fetching, render the points
          requestAnimationFrame(renderTerrainPoints)
        }
      } else {
        console.log('All terrain points loaded from localStorage.')
        // Draw lines and create mesh if all points are loaded
        drawTerrainLinesAsync(savedPoints) // Use asynchronous line drawing
        createTerrainMesh(savedPoints)
      }

      // Handle excess points if any
      const totalSavedPoints = loadPointsFromLocalStorage().length
      if (totalSavedPoints > totalPoints) {
        console.warn(
          `Total saved points (${totalSavedPoints}) exceed the expected grid size (${totalPoints}). Truncating excess points.`
        )
        const truncatedPoints = loadPointsFromLocalStorage().slice(0, totalPoints)
        localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(truncatedPoints))
        populateTerrainFromSavedPoints(truncatedPoints)
        nextPointIndex = truncatedPoints.length
        drawTerrainLinesAsync(truncatedPoints)
        createTerrainMesh(truncatedPoints)
      }

      previousLocation = { latitude, longitude }
    } catch (error) {
      console.error('Error during terrain initialization:', error)
    }
  } else {
    // Terrain has been initialized, check for movement and expand grid if necessary
    const movementThreshold = 10 // Meters; adjust as needed
    const movementDistance = calculateDistance(
      previousLocation.latitude,
      previousLocation.longitude,
      latitude,
      longitude
    )

    if (movementDistance >= movementThreshold) {
      console.log(
        `Detected movement. Previous Location: (${previousLocation.latitude.toFixed(
          5
        )}, ${previousLocation.longitude.toFixed(
          5
        )}), New Location: (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`
      )

      // Determine direction of movement
      const deltaLat = latitude - previousLocation.latitude
      const deltaLon = longitude - previousLocation.longitude

      // Update grid boundaries based on movement
      if (deltaLat > 0) {
        // Moving North; add new row to the north
        await addNewRow('north')
      } else if (deltaLat < 0) {
        // Moving South; add new row to the south
        await addNewRow('south')
      }

      if (deltaLon > 0) {
        // Moving East; add new column to the east
        await addNewColumn('east')
      } else if (deltaLon < 0) {
        // Moving West; add new column to the west
        await addNewColumn('west')
      }

      previousLocation = { latitude, longitude }
    } else {
      console.log(`Movement detected (${movementDistance.toFixed(2)} meters) is below the threshold (${movementThreshold} meters).`)
    }
  }
})

/**
 * Initializes the Three.js terrain point cloud.
 */
function initializeTerrainPointCloud() {
  const positions = new Float32Array(totalPoints * 3)
  const colors = new Float32Array(totalPoints * 3)

  terrainGeometry = new THREE.BufferGeometry()
  terrainGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions, 3)
  )
  terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  terrainMaterial = new THREE.PointsMaterial({
    size: 0.1,
    vertexColors: true,
    transparent: true,
    opacity: 0.5
  })

  terrainPointCloud = new THREE.Points(terrainGeometry, terrainMaterial)
  scene.add(terrainPointCloud)
}

/**
 * Populates the terrain point cloud from saved points.
 * Ensures that only up to totalPoints are processed.
 * @param {Array} savedPoints - Array of saved point objects.
 */
function populateTerrainFromSavedPoints(savedPoints) {
  const positions = terrainPointCloud.geometry.attributes.position.array
  const colors = terrainPointCloud.geometry.attributes.color.array
  const metersPerDegLat = 111320 * scaleMultiplier
  const metersPerDegLon = 110540 * scaleMultiplier

  const pointsToPopulate = savedPoints.slice(0, totalPoints) // Ensure no excess points

  pointsToPopulate.forEach((point, index) => {
    const baseIndex = index * 3
    positions[baseIndex] =
      (point.longitude - originLongitude) * metersPerDegLon
    positions[baseIndex + 1] =
      (point.elevation - referenceElevation) * scaleMultiplier
    positions[baseIndex + 2] =
      (point.latitude - originLatitude) * metersPerDegLat

    const normalizedElevation =
      Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80
    const color = new THREE.Color().lerpColors(
      new THREE.Color(0x000000), // Blue for low elevation
      new THREE.Color(0xffffff), // Red for high elevation
      normalizedElevation
    )

    colors[baseIndex] = color.r
    colors[baseIndex + 1] = color.g
    colors[baseIndex + 2] = color.b
  })

  terrainPointCloud.geometry.attributes.position.needsUpdate = true
  terrainPointCloud.geometry.attributes.color.needsUpdate = true

  console.log(`Populated terrain with ${pointsToPopulate.length} saved points.`)
}

/**
 * Renders new terrain points into the scene.
 * Ensures that no more than totalPoints are rendered.
 */
function renderTerrainPoints() {
  if (!terrainPointCloud || window.elevationData.length === 0) return

  const positions = terrainPointCloud.geometry.attributes.position.array
  const colors = terrainPointCloud.geometry.attributes.color.array

  const pointsToAdd = Math.min(
    POINTS_BATCH_SIZE,
    window.elevationData.length,
    totalPoints - nextPointIndex
  )

  if (pointsToAdd <= 0) {
    // Once all points are rendered, draw lines and create mesh
    const allSavedPoints = loadPointsFromLocalStorage()
    drawTerrainLinesAsync(allSavedPoints) // Asynchronous line drawing
    createTerrainMesh(allSavedPoints)
    return
  }

  const pointsBatch = []
  for (let i = 0; i < pointsToAdd; i++) {
    const point = window.elevationData.shift()
    if (!point) continue

    const baseIndex = nextPointIndex * 3

    positions[baseIndex] =
      (point.longitude - originLongitude) * 110540 * scaleMultiplier
    positions[baseIndex + 1] =
      (point.elevation - referenceElevation) * scaleMultiplier
    positions[baseIndex + 2] =
      (point.latitude - originLatitude) * 111320 * scaleMultiplier

    const normalizedElevation =
      Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80
    const color = new THREE.Color().lerpColors(
      new THREE.Color(0x000000), // Blue for low elevation
      new THREE.Color(0xffffff), // Red for high elevation
      normalizedElevation
    )

    colors[baseIndex] = color.r
    colors[baseIndex + 1] = color.g
    colors[baseIndex + 2] = color.b

    pointsBatch.push(point)
    nextPointIndex++

    // Prevent exceeding totalPoints
    if (nextPointIndex >= totalPoints) {
      break
    }
  }

  terrainPointCloud.geometry.attributes.position.needsUpdate = true
  terrainPointCloud.geometry.attributes.color.needsUpdate = true

  savePointsToLocalStorage(pointsBatch)

  console.log(`Rendered ${nextPointIndex} / ${totalPoints} points.`)
  const progress = `Rendered ${nextPointIndex} / ${totalPoints} points.`
  updateField('progress', progress)

  if (nextPointIndex >= totalPoints) {
    // All points rendered, draw lines and create mesh
    const allSavedPoints = loadPointsFromLocalStorage()
    drawTerrainLinesAsync(allSavedPoints) // Asynchronous line drawing
    createTerrainMesh(allSavedPoints)
  } else {
    // Continue rendering in the next frame
    requestAnimationFrame(renderTerrainPoints)
  }
}

/**
 * Draws terrain lines asynchronously to prevent blocking the main thread.
 * @param {Array} savedPoints - Array of saved point objects.
 */
function drawTerrainLinesAsync(savedPoints) {
  if (!lineDrawingGenerator) {
    lineDrawingGenerator = terrainLineDrawingGenerator(savedPoints)
  }

  const result = lineDrawingGenerator.next()
  if (result.done) {
    lineDrawingGenerator = null // Reset generator when done
    console.log('Asynchronous terrain lines drawing completed.')
  } else {
    // Continue drawing in the next frame
    requestAnimationFrame(() => drawTerrainLinesAsync(savedPoints))
  }
}

let lineDrawingGenerator = null

/**
 * Generator function for drawing terrain lines.
 * Processes the grid in chunks to avoid blocking.
 * @param {Array} savedPoints - Array of saved point objects.
 */
function* terrainLineDrawingGenerator(savedPoints) {
  const linePositions = []
  const metersPerDegLat = 111320 * scaleMultiplier
  const metersPerDegLon = 110540 * scaleMultiplier

  const gridSize = gridResolution // Number of rows and columns
  if (!Number.isInteger(gridSize)) {
    console.error(
      'Grid size is not an integer. Cannot draw lines accurately.'
    )
    return
  }

  // Define the maximum allowed distance between connected points (in meters)
  const maxLineDistance = 15 // Adjust this value based on your grid density
  const maxLineDistanceSq = maxLineDistance * maxLineDistance // Squared distance for efficiency

  // Function to calculate squared distance between two points (X and Z axes only)
  const calculateDistanceSq = (x1, z1, x2, z2) => {
    const dx = x1 - x2
    const dz = z1 - z2
    return dx * dx + dz * dz
  }

  // Set to track connected pairs and prevent duplicates
  const connectedPairs = new Set()

  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const currentIndex = i * gridSize + j
      const currentPoint = savedPoints[currentIndex]
      if (!currentPoint) continue

      const currentX =
        (currentPoint.longitude - originLongitude) * metersPerDegLon
      const currentZ =
        (currentPoint.latitude - originLatitude) * metersPerDegLat
      const currentY =
        (currentPoint.elevation - referenceElevation) * scaleMultiplier

      // Right neighbor (only if not on the last column)
      if (j < gridSize - 1) {
        const rightNeighborIndex = currentIndex + 1
        const rightNeighbor = savedPoints[rightNeighborIndex]
        if (rightNeighbor) {
          const rightX =
            (rightNeighbor.longitude - originLongitude) * metersPerDegLon
          const rightZ =
            (rightNeighbor.latitude - originLatitude) * metersPerDegLat
          const rightY =
            (rightNeighbor.elevation - referenceElevation) * scaleMultiplier

          const distanceSq = calculateDistanceSq(
            currentX,
            currentZ,
            rightX,
            rightZ
          )
          if (distanceSq <= maxLineDistanceSq) {
            // Create a unique key for the pair to prevent duplicates
            const key =
              currentIndex < rightNeighborIndex
                ? `${currentIndex}-${rightNeighborIndex}`
                : `${rightNeighborIndex}-${currentIndex}`

            if (!connectedPairs.has(key)) {
              connectedPairs.add(key)
              linePositions.push(
                currentX,
                currentY,
                currentZ,
                rightX,
                rightY,
                rightZ
              )
            }
          }
        }
      }

      // Bottom neighbor (only if not on the last row)
      if (i < gridSize - 1) {
        const bottomNeighborIndex = currentIndex + gridSize
        const bottomNeighbor = savedPoints[bottomNeighborIndex]
        if (bottomNeighbor) {
          const bottomX =
            (bottomNeighbor.longitude - originLongitude) * metersPerDegLon
          const bottomZ =
            (bottomNeighbor.latitude - originLatitude) * metersPerDegLat
          const bottomY =
            (bottomNeighbor.elevation - referenceElevation) * scaleMultiplier

          const distanceSq = calculateDistanceSq(
            currentX,
            currentZ,
            bottomX,
            bottomZ
          )
          if (distanceSq <= maxLineDistanceSq) {
            // Create a unique key for the pair to prevent duplicates
            const key =
              currentIndex < bottomNeighborIndex
                ? `${currentIndex}-${bottomNeighborIndex}`
                : `${bottomNeighborIndex}-${currentIndex}`

            if (!connectedPairs.has(key)) {
              connectedPairs.add(key)
              linePositions.push(
                currentX,
                currentY,
                currentZ,
                bottomX,
                bottomY,
                bottomZ
              )
            }
          }
        }
      }

      // Yield after processing a set number of points to allow the main thread to breathe
      if ((i * gridSize + j) % 1000 === 0) {
        // Adjust the modulus value based on desired yield frequency
        yield
      }
    }
  }

  // After all lines are collected, create the line segments
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(linePositions, 3)
  )

  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    opacity: 0.5,
    transparent: true
  })
  terrainLineSegments = new THREE.LineSegments(lineGeometry, lineMaterial)
  //scene.add(terrainLineSegments)

  yield // Final yield to indicate completion
}

const gridRows = gridResolution // Number of rows in the grid
const gridCols = gridResolution // Number of columns in the grid

/**
 * Creates the terrain mesh from saved points.
 * Ensures that the number of points matches the grid's expectation.
 * @param {Array} savedPoints - Array of saved point objects.
 */
function createTerrainMesh(savedPoints) {
  // Ensure gridRows and gridCols are defined
  if (typeof gridRows === 'undefined' || typeof gridCols === 'undefined') {
    console.error(
      'gridRows and gridCols must be defined before creating the terrain mesh.'
    )
    return
  }

  // Validate the length of savedPoints
  if (savedPoints.length > gridRows * gridCols) {
    console.warn(
      `Expected at most ${gridRows * gridCols} points, but got ${savedPoints.length}. Truncating excess points.`
    )
    savedPoints = savedPoints.slice(0, gridRows * gridCols)
    localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(savedPoints))
  }

  if (savedPoints.length < gridRows * gridCols) {
    console.warn(
      `Expected ${gridRows * gridCols} points, but got ${savedPoints.length}. Attempting to generate missing points.`
    )
    const missingPoints = gridRows * gridCols - savedPoints.length
    for (let i = 0; i < missingPoints; i++) {
      // Find the first empty spot in the grid
      const row = Math.floor(i / gridCols)
      const col = i % gridCols
      if (savedPoints[row * gridCols + col] === undefined) {
        // Generate a new point by interpolating from neighbors
        const generatedPoint = generateMissingPoint(row, col, sortedGrid)
        if (generatedPoint) {
          savedPoints[row * gridCols + col] = generatedPoint
          window.elevationData.push(generatedPoint)
        } else {
          // If unable to generate, assign a default elevation
          savedPoints[row * gridCols + col] = {
            longitude: originLongitude,
            latitude: originLatitude,
            elevation: referenceElevation
          }
          window.elevationData.push(savedPoints[row * gridCols + col])
        }
      }
    }
    localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(savedPoints))
  }

  // Re-validate the point count
  if (savedPoints.length !== gridRows * gridCols) {
    console.error(
      `After handling, expected ${gridRows * gridCols} points, but got ${savedPoints.length}. Aborting mesh creation.`
    )
    return
  }

  // Define meters per degree based on a fixed latitude for simplicity
  const metersPerDegLat = 111320 * scaleMultiplier
  const metersPerDegLon = 110540 * scaleMultiplier // Adjust based on average latitude if necessary

  // Define origin for global positioning (fixed at initial location)
  const origin = {
    longitude: originLongitude,
    latitude: originLatitude
  }

  // Function to calculate squared distance between two points (X and Z axes only)
  const calculateDistanceSq = (x1, z1, x2, z2) => {
    const dx = x1 - x2
    const dz = z1 - z2
    return dx * dx + dz * dz
  }

  // Step 1: Determine global min and max for X (longitude) and Z (latitude)
  const xCoords = savedPoints.map(
    point => (point.longitude - origin.longitude) * metersPerDegLon
  )
  const zCoords = savedPoints.map(
    point => (point.latitude - origin.latitude) * metersPerDegLat
  )

  const minX = Math.min(...xCoords)
  const maxX = Math.max(...xCoords)
  const minZ = Math.min(...zCoords)
  const maxZ = Math.max(...zCoords)

  // Calculate expected grid spacing
  const deltaX = (maxX - minX) / (gridCols - 1)
  const deltaZ = (maxZ - minZ) / (gridRows - 1)

  // Initialize a 2D array to hold sorted points
  const sortedGrid = Array.from({ length: gridRows }, () =>
    Array(gridCols).fill(null)
  )

  // Step 2: Assign each saved point to the appropriate grid cell
  savedPoints.forEach(point => {
    // Convert geographic coordinates to meters relative to origin
    const x = (point.longitude - origin.longitude) * metersPerDegLon
    const z = (point.latitude - origin.latitude) * metersPerDegLat

    // Calculate column and row indices based on grid spacing
    let col = Math.round((x - minX) / deltaX)
    let row = Math.round((z - minZ) / deltaZ)

    // Clamp indices to valid range
    col = Math.max(0, Math.min(gridCols - 1, col))
    row = Math.max(0, Math.min(gridRows - 1, row))

    // Assign the point to the grid cell
    if (sortedGrid[row][col] === null) {
      sortedGrid[row][col] = point
    } else {
      // Handle duplicate assignments by choosing the closest point
      const existingPoint = sortedGrid[row][col]
      const existingX =
        (existingPoint.longitude - origin.longitude) * metersPerDegLon
      const existingZ =
        (existingPoint.latitude - origin.latitude) * metersPerDegLat
      const existingDistanceSq = calculateDistanceSq(existingX, existingZ, x, z)

      // Calculate distance for the new point (should be zero if exact duplicate)
      const newDistanceSq = calculateDistanceSq(existingX, existingZ, x, z)

      if (newDistanceSq < existingDistanceSq) {
        sortedGrid[row][col] = point
      } else {
        console.warn(
          `Duplicate point assignment at row ${row}, col ${col}. Keeping the existing point.`
        )
      }
    }
  })

  // Step 3: Handle Missing Points by Generating Them
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      if (sortedGrid[row][col] === null) {
        console.warn(
          `Missing point at row ${row}, col ${col}. Generating a new point.`
        )

        // Generate a new point by interpolating from existing neighbors
        const generatedPoint = generateMissingPoint(row, col, sortedGrid)

        if (generatedPoint) {
          sortedGrid[row][col] = generatedPoint
          console.log(
            `Generated point at row ${row}, col ${col}: Lat=${generatedPoint.latitude.toFixed(
              5
            )}, Lon=${generatedPoint.longitude.toFixed(
              5
            )}, Elevation=${generatedPoint.elevation}`
          )
        } else {
          // If unable to generate, assign a default elevation
          const defaultElevation = referenceElevation
          const generatedLongitude =
            minX + col * deltaX / metersPerDegLon + origin.longitude
          const generatedLatitude =
            minZ + row * deltaZ / metersPerDegLat + origin.latitude

          const defaultPoint = {
            longitude: generatedLongitude,
            latitude: generatedLatitude,
            elevation: defaultElevation
          }

          sortedGrid[row][col] = defaultPoint
          console.warn(
            `Assigned default elevation for missing point at row ${row}, col ${col}.`
          )
        }
      }
    }
  }

  // Step 4: Populate Vertices and Colors
  const vertices = new Float32Array(totalPoints * 3) // x, y, z for each point
  const colors = new Float32Array(totalPoints * 3) // r, g, b for each point

  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const index = row * gridCols + col
      const point = sortedGrid[row][col]
      const vertexIndex = index * 3

      // Convert geographic coordinates to meters relative to origin
      const x = (point.longitude - origin.longitude) * metersPerDegLon // x
      const y = (point.elevation - referenceElevation) * scaleMultiplier // y
      const z = (point.latitude - origin.latitude) * metersPerDegLat // z

      vertices[vertexIndex] = x
      vertices[vertexIndex + 1] = y
      vertices[vertexIndex + 2] = z

      // Calculate color based on elevation
      const normalizedElevation =
        Math.min(Math.max(point.elevation - referenceElevation, 0), 40) / 40
      const color = new THREE.Color().lerpColors(
        new THREE.Color(0x000000), // Blue for low elevation
        new THREE.Color(0xffffff), // Red for high elevation
        normalizedElevation
      )
      colors[vertexIndex] = color.r
      colors[vertexIndex + 1] = color.g
      colors[vertexIndex + 2] = color.b
    }
  }

  // Step 5: Generate Indices for Triangles Based on Physical Neighbors
  const indices = []
  const maxTriangleSize = 400 // Adjust based on grid density
  const maxTriangleSizeSq = maxTriangleSize * maxTriangleSize // Squared distance for efficiency

  for (let row = 0; row < gridRows - 1; row++) {
    for (let col = 0; col < gridCols - 1; col++) {
      const a = row * gridCols + col
      const b = a + 1
      const c = a + gridCols
      const d = c + 1

      // Retrieve vertex positions (X and Z axes only)
      const ax = vertices[a * 3]
      const az = vertices[a * 3 + 2]
      const bx = vertices[b * 3]
      const bz = vertices[b * 3 + 2]
      const cx = vertices[c * 3]
      const cz = vertices[c * 3 + 2]
      const dxPos = vertices[d * 3]
      const dz = vertices[d * 3 + 2]

      // Calculate squared distances to ensure physical proximity
      const distanceACSq = calculateDistanceSq(ax, az, cx, cz)
      const distanceCBSq = calculateDistanceSq(cx, cz, bx, bz)
      const distanceABSq = calculateDistanceSq(ax, az, bx, bz)

      const distanceBCSq = calculateDistanceSq(bx, bz, cx, cz)
      const distanceCDSq = calculateDistanceSq(cx, cz, dxPos, dz)
      const distanceBDSq = calculateDistanceSq(bx, bz, dxPos, dz)

      // Validate distances for the first triangle (a, c, b)
      const isTriangle1Valid =
        distanceACSq <= maxTriangleSizeSq &&
        distanceCBSq <= maxTriangleSizeSq &&
        distanceABSq <= maxTriangleSizeSq

      // Validate distances for the second triangle (b, c, d)
      const isTriangle2Valid =
        distanceBCSq <= maxTriangleSizeSq &&
        distanceCDSq <= maxTriangleSizeSq &&
        distanceBDSq <= maxTriangleSizeSq

      // Only add triangles if they pass the distance validation
      if (isTriangle1Valid && isTriangle2Valid) {
        // First triangle (a, c, b)
        indices.push(a, c, b)

        // Second triangle (b, c, d)
        indices.push(b, c, d)
      } else {
        console.warn(
          `Skipped grid square at row ${row}, col ${col} due to excessive triangle size.`
        )
      }
    }
  }

  // Step 6: Assign Attributes to Geometry
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()

  // Step 7: Create Material with Vertex Colors, Shading, and Reflectivity
  const materialWire = new THREE.MeshStandardMaterial({
    vertexColors: true, // Enable vertex colors
    wireframe: true, // Wireframe for visual clarity
    transparent: true, // Enable transparency
    opacity: 0.2, // Set opacity level
    metalness: 0.7, // Slight reflectivity (range: 0.0 - 1.0)
    roughness: 0.2 // Moderate roughness for shading (range: 0.0 - 1.0)

    // Optional: Add an environment map for enhanced reflections
    // envMap: yourEnvironmentMap,      // Replace with your environment map texture
    // envMapIntensity: 1.0,            // Adjust the intensity of the environment map
  })

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, // Enable vertex colors
    wireframe: false, // Solid mesh
    transparent: true, // Enable transparency
    side: THREE.DoubleSide,
    opacity: 0.95, // Full opacity
    metalness: 0.2, // Higher reflectivity
    roughness: 0.7 // Moderate roughness

    // Optional: Add an environment map for enhanced reflections
    // envMap: yourEnvironmentMap,      // Replace with your environment map texture
    // envMapIntensity: 1.0,            // Adjust the intensity of the environment map
  })

  // Step 8: Create and Add the Terrain Mesh to the Scene
  terrainMesh = new THREE.Mesh(geometry, material)
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

  // Step 8: Create and Add the Terrain Mesh Wireframe to the Scene
  terrainMeshWire = new THREE.Mesh(geometry, materialWire)
  scene.add(terrainMeshWire)

  console.log('Terrain mesh created and added to the scene.')
}

/**
 * Generates a missing point by interpolating elevation from neighboring points.
 * @param {number} row - Row index in the grid.
 * @param {number} col - Column index in the grid.
 * @param {Array} sortedGrid - 2D array of sorted points.
 * @returns {Object|null} Generated point object or null if unable to generate.
 */
function generateMissingPoint(row, col, sortedGrid) {
  const neighbors = []

  // Define neighbor offsets (Left, Right, Below, Above, Top-Left, Top-Right, Bottom-Left, Bottom-Right)
  const neighborOffsets = [
    [row, col - 1], // Left
    [row, col + 1], // Right
    [row - 1, col], // Below
    [row + 1, col], // Above
    [row - 1, col - 1], // Top-Left
    [row - 1, col + 1], // Top-Right
    [row + 1, col - 1], // Bottom-Left
    [row + 1, col + 1]  // Bottom-Right
  ]

  neighborOffsets.forEach(offset => {
    const [nRow, nCol] = offset
    if (nRow >= 0 && nRow < gridResolution && nCol >= 0 && nCol < gridResolution) {
      const neighborPoint = sortedGrid[nRow][nCol]
      if (neighborPoint !== null) {
        neighbors.push(neighborPoint.elevation)
      }
    }
  })

  if (neighbors.length === 0) {
    return null // Unable to generate without neighbors
  }

  // Calculate average elevation from neighbors
  const sum = neighbors.reduce((acc, val) => acc + val, 0)
  const averageElevation = sum / neighbors.length

  // Calculate longitude and latitude based on grid indices
  const stepMeters = (2 * gridSizeMeters) / (gridResolution - 1)
  const deltaLat = stepMeters / 111000
  const deltaLon =
    stepMeters / (111000 * Math.cos(THREE.MathUtils.degToRad(originLatitude)))

  const generatedLongitude = originLongitude + (col - (gridResolution - 1) / 2) * deltaLon
  const generatedLatitude = originLatitude + (row - (gridResolution - 1) / 2) * deltaLat

  return {
    longitude: generatedLongitude,
    latitude: generatedLatitude,
    elevation: averageElevation
  }
}

/**
 * Reports the player's current geographic position by finding the closest terrain point.
 * Updates the HTML element with ID 'position' to display latitude and longitude.
 */
function reportPosition() {
  if (!terrainPointCloud || !localModel) return;

  // Extract the local model's current x and z positions
  const userX = localModel.position.x;
  const userZ = localModel.position.z;

  // Find the closest grid point
  const closestPoint = findClosestGridPoint(userX, userZ);

  if (closestPoint) {
    // Format latitude and longitude to 5 decimal places for readability
    const formattedLat = parseFloat(closestPoint.latitude.toFixed(5));
    const formattedLon = parseFloat(closestPoint.longitude.toFixed(5));

    // Update window.latitudeDelta and window.longitudeDelta
    window.latitudeDelta = formattedLat;
    window.longitudeDelta = formattedLon;

    // Update the HTML element with the formatted latitude and longitude
    updateField('position', `Lat: ${formattedLat}, Lon: ${formattedLon}`);
  } else {
    // Handle cases where no closest point is found
    updateField('position', 'Position: Unknown');
  }
}

/**
 * Finds the closest grid point to the given x and z coordinates and returns its latitude and longitude.
 * Also triggers grid expansion if the user is near the grid boundaries.
 * @param {number} x - The x-coordinate of the user in the scene.
 * @param {number} z - The z-coordinate of the user in the scene.
 * @returns {Object|null} The closest grid point with latitude and longitude or null if not found.
 */
function findClosestGridPoint(x, z) {
  if (!terrainPointCloud) return null

  const positions = terrainPointCloud.geometry.attributes.position.array
  let minDistance = Infinity
  let closestPoint = null

  // Define meters per degree based on scaleMultiplier
  const metersPerDegLat = 111320 * scaleMultiplier // Approximately meters per degree latitude
  const metersPerDegLon = 110540 * scaleMultiplier // Approximately meters per degree longitude

  // Reference origin from window object
  const origin = {
    longitude: originLongitude,
    latitude: originLatitude
  }

  // Variables to track user's grid position
  let userGridRow = null
  let userGridCol = null

  // Iterate through all points to find the closest one
  for (let i = 0; i < positions.length; i += 3) {
    const pointX = positions[i]
    const pointY = positions[i + 1]
    const pointZ = positions[i + 2]

    const dx = x - pointX
    const dz = z - pointZ
    const distance = dx * dx + dz * dz // Squared distance for efficiency

    if (distance < minDistance) {
      minDistance = distance
      // Convert x and z back to latitude and longitude
      const generatedLongitude = pointX / metersPerDegLon + origin.longitude
      const generatedLatitude = pointZ / metersPerDegLat + origin.latitude

      closestPoint = {
        latitude: generatedLatitude,
        longitude: generatedLongitude
      }

      // Determine grid row and column
      userGridRow = Math.floor((pointZ) / metersPerDegLat) + gridResolution / 2
      userGridCol = Math.floor((pointX) / metersPerDegLon) + gridResolution / 2
    }
  }

  // Define a buffer zone to preemptively add new rows/columns
  const bufferZone = Math.floor(gridResolution * 0.1) // 10% of the grid as buffer (e.g., 10 for 100)

  // Determine proximity to grid boundaries
  const nearNorth = userGridRow >= gridResolution - bufferZone
  const nearSouth = userGridRow <= bufferZone
  const nearEast = userGridCol >= gridResolution - bufferZone
  const nearWest = userGridCol <= bufferZone

  // Trigger grid expansion based on proximity
  if (nearNorth) {
    console.log('User is near the northern boundary. Adding new row to the north.')
    addNewRow('north')
  }
  if (nearSouth) {
    console.log('User is near the southern boundary. Adding new row to the south.')
    addNewRow('south')
  }
  if (nearEast) {
    console.log('User is near the eastern boundary. Adding new column to the east.')
    addNewColumn('east')
  }
  if (nearWest) {
    console.log('User is near the western boundary. Adding new column to the west.')
    addNewColumn('west')
  }

  return closestPoint
}

/**
 * Adds a new row to the terrain grid in the specified direction.
 * @param {string} direction - 'north' or 'south'.
 */
async function addNewRow(direction) {
  console.log(`Adding a new row to the ${direction}.`)

  // Determine new row latitude
  let newRowLatitude
  if (direction === 'north') {
    newRowLatitude = gridMaxLat + (2 * gridSizeMeters) / 111000
    gridMaxLat = newRowLatitude
  } else if (direction === 'south') {
    newRowLatitude = gridMinLat - (2 * gridSizeMeters) / 111000
    gridMinLat = newRowLatitude
  } else {
    console.error(`Invalid direction "${direction}" for adding a new row.`)
    return
  }

  // Generate new row points
  const metersPerDegLat = 111000 // Approximate meters per degree latitude
  const metersPerDegLon = 111000 * Math.cos(THREE.MathUtils.degToRad(previousLocation.latitude)) // Adjust based on latitude

  const stepMeters = (2 * gridSizeMeters) / (gridResolution - 1)
  const deltaLon = stepMeters / metersPerDegLon

  const newPoints = []
  for (let j = 0; j < gridResolution; j++) {
    const lonOffset = (j - (gridResolution - 1) / 2) * deltaLon
    const newLongitude = originLongitude + lonOffset
    const newLatitude = newRowLatitude

    newPoints.push({
      latitude: newLatitude,
      longitude: newLongitude
    })
  }

  // Fetch elevation data for new points
  await fetchElevationGrid(newPoints, 'Meters', 10, 3)

  // Render the new points
  await renderNewPoints(newPoints, direction)

  // Update localStorage
  savePointsToLocalStorage(window.elevationData)

  // Clear elevationData buffer
  window.elevationData = []

  // Update mesh
  const allSavedPoints = loadPointsFromLocalStorage()
  drawTerrainLinesAsync(allSavedPoints)
  createTerrainMesh(allSavedPoints)
}

/**
 * Adds a new column to the terrain grid in the specified direction.
 * @param {string} direction - 'east' or 'west'.
 */
async function addNewColumn(direction) {
  console.log(`Adding a new column to the ${direction}.`)

  // Determine new column longitude
  let newColLongitude
  if (direction === 'east') {
    newColLongitude = gridMaxLon + (2 * gridSizeMeters) / (111000 * Math.cos(THREE.MathUtils.degToRad(previousLocation.latitude)))
    gridMaxLon = newColLongitude
  } else if (direction === 'west') {
    newColLongitude = gridMinLon - (2 * gridSizeMeters) / (111000 * Math.cos(THREE.MathUtils.degToRad(previousLocation.latitude)))
    gridMinLon = newColLongitude
  } else {
    console.error(`Invalid direction "${direction}" for adding a new column.`)
    return
  }

  // Generate new column points
  const metersPerDegLat = 111000 // Approximate meters per degree latitude
  const metersPerDegLon = 111000 * Math.cos(THREE.MathUtils.degToRad(previousLocation.latitude)) // Adjust based on latitude

  const stepMeters = (2 * gridSizeMeters) / (gridResolution - 1)
  const deltaLat = stepMeters / metersPerDegLat

  const newPoints = []
  for (let i = 0; i < gridResolution; i++) {
    const latOffset = (i - (gridResolution - 1) / 2) * deltaLat
    const newLatitude = originLatitude + latOffset
    const newLongitude = newColLongitude

    newPoints.push({
      latitude: newLatitude,
      longitude: newLongitude
    })
  }

  // Fetch elevation data for new points
  await fetchElevationGrid(newPoints, 'Meters', 10, 3)

  // Render the new points
  await renderNewPoints(newPoints, direction)

  // Update localStorage
  savePointsToLocalStorage(window.elevationData)

  // Clear elevationData buffer
  window.elevationData = []

  // Update mesh
  const allSavedPoints = loadPointsFromLocalStorage()
  drawTerrainLinesAsync(allSavedPoints)
  createTerrainMesh(allSavedPoints)
}

/**
 * Renders new terrain points based on the added direction.
 * @param {Array} newPoints - Array of newly fetched elevation points.
 * @param {string} direction - Direction where points are added ('north', 'south', 'east', 'west').
 */
async function renderNewPoints(newPoints, direction) {
  if (!terrainPointCloud) {
    console.error('Terrain Point Cloud is not initialized.')
    return
  }

  const positions = terrainPointCloud.geometry.attributes.position.array
  const colors = terrainPointCloud.geometry.attributes.color.array

  // Determine starting index based on direction
  let startIndex
  if (direction === 'north' || direction === 'east') {
    startIndex = nextPointIndex
  } else if (direction === 'south' || direction === 'west') {
    startIndex = 0 // Insert at the beginning
  } else {
    console.error(`Invalid direction "${direction}" for rendering new points.`)
    return
  }

  for (let i = 0; i < newPoints.length; i++) {
    const point = newPoints[i]
    if (!point) continue

    const index = direction === 'south' || direction === 'west' ? i : nextPointIndex
    const baseIndex = index * 3

    const metersPerDegLat = 111000 * scaleMultiplier
    const metersPerDegLon = 111000 * Math.cos(THREE.MathUtils.degToRad(point.latitude)) * scaleMultiplier

    const x = (point.longitude - originLongitude) * metersPerDegLon
    const y = (point.elevation - referenceElevation) * scaleMultiplier
    const z = (point.latitude - originLatitude) * metersPerDegLat

    positions[baseIndex] = x
    positions[baseIndex + 1] = y
    positions[baseIndex + 2] = z

    const normalizedElevation =
      Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80
    const color = new THREE.Color().lerpColors(
      new THREE.Color(0x5555ff), // Blue for low elevation
      new THREE.Color(0xff5555), // Red for high elevation
      normalizedElevation
    )

    colors[baseIndex] = color.r
    colors[baseIndex + 1] = color.g
    colors[baseIndex + 2] = color.b

    if (direction === 'north' || direction === 'east') {
      nextPointIndex++
    }
  }

  terrainPointCloud.geometry.attributes.position.needsUpdate = true
  terrainPointCloud.geometry.attributes.color.needsUpdate = true

  console.log(`Rendered ${nextPointIndex} / ${totalPoints} points.`)
  const progress = `Rendered ${nextPointIndex} / ${totalPoints} points.`
  updateField('progress', progress)
}

/**
 * Calculates the distance between two geographic points using the Haversine formula.
 * @param {number} lat1 - Latitude of the first point.
 * @param {number} lon1 - Longitude of the first point.
 * @param {number} lat2 - Latitude of the second point.
 * @param {number} lon2 - Longitude of the second point.
 * @returns {number} Distance in meters.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const phi1 = THREE.MathUtils.degToRad(lat1)
  const phi2 = THREE.MathUtils.degToRad(lat2)
  const deltaPhi = THREE.MathUtils.degToRad(lat2 - lat1)
  const deltaLambda = THREE.MathUtils.degToRad(lon2 - lon1)

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) *
    Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  const distance = R * c
  return distance
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
// Normalize an angle to the range [-π, π] using Math.atan2
function normalizeAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
// Flag to indicate which system is controlling the camera
let controllingSystem = null; // 'pointerLock' or 'deviceOrientation'

// Update Camera Quaternion based on mouse movement
function updateCameraQuaternion(deltaYaw, deltaPitch) {
  const euler = new THREE.Euler(deltaPitch, deltaYaw, 0, 'YXZ');
  const q = new THREE.Quaternion().setFromEuler(euler);
  cameraQuaternion.multiply(q);
  cameraQuaternion.normalize();
  camera.quaternion.copy(cameraQuaternion);
}

// Enable Pointer Lock Controls
function enablePointerLock() {
  const canvas = renderer.domElement;

  // Request pointer lock on canvas click
  canvas.addEventListener("click", () => {
    if (!renderer.xr.isPresenting) {
      canvas.requestPointerLock();
    }
  });

}

// ------------------------------
// getCameraYaw() - Helper to retrieve camera's yaw
// ------------------------------
function getCameraYaw() {
  // Create a new Euler object with the desired rotation order
  const euler = new THREE.Euler(0, 0, 0, "YXZ");

  // Set the Euler angles from the camera's quaternion
  euler.setFromQuaternion(camera.quaternion, "YXZ"); // Ensure correct rotation order

  // Extract the yaw (rotation around Y-axis)
  const yaw = euler.y;

  // Normalize the yaw to [-π, π]
  const normalizedYaw = normalizeAngle(yaw);

  return normalizedYaw;
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
    const terrainHeight = getTerrainHeightAt(
      localModel.position.x,
      localModel.position.z
    )

    const teleportSpaceOffset =
      baseReferenceSpace.getOffsetReferenceSpace(transform)
    renderer.xr.setReferenceSpace(teleportSpaceOffset)

    // Move localModel
    localModel.position.set(INTERSECTION.x, terrainHeight, INTERSECTION.z)
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
    const terrainHeight = getTerrainHeightAt(
      localModel.position.x,
      localModel.position.z
    )
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
  if (terrainMesh === NaN) return 0

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
  const session = renderer.xr.getSession()
  if (!session || !localModel) return

  for (const source of session.inputSources) {
    if (!source.gamepad) continue

    // 1) LEFT joystick for forward/strafe
    if (source.handedness === 'left') {
      const { axes, buttons } = source.gamepad
      const strafe = axes[0]
      const forwardVal = -axes[1] // push up is negative

      // Basic deadzone
      const deadZone = 0.15
      const moveX = Math.abs(strafe) > deadZone ? strafe : 0
      const moveZ = Math.abs(forwardVal) > deadZone ? forwardVal : 0

      // Decide animation
      const magnitude = Math.sqrt(moveX * moveX + moveZ * moveZ)
      const threshold = 0.7
      if (magnitude > 0.01) {
        if (magnitude > threshold) {
          setLocalAction('run')
        } else {
          setLocalAction('walk')
        }
      } else {
        setLocalAction('idle')
      }

      // Incorporate run logic via a button check:
      // e.g., isRunning = buttons[1].pressed (typically the trigger)
      isRunning = buttons[1]?.pressed || false

      const speed = isRunning ? runSpeed : walkSpeed

      // Move relative to camera direction
      const cameraDirection = new THREE.Vector3()
      camera.getWorldDirection(cameraDirection)
      cameraDirection.y = 0
      cameraDirection.normalize()

      const sideVector = new THREE.Vector3()
      sideVector
        .crossVectors(new THREE.Vector3(0, 1, 0), cameraDirection)
        .normalize()

      const movement = new THREE.Vector3()
      movement.addScaledVector(cameraDirection, moveZ * speed * delta)
      movement.addScaledVector(sideVector, moveX * speed * delta)

      // Move the local model
      localModel.position.add(movement)

      // Adjust y-position based on terrain
      const terrainHeight = getTerrainHeightAt(
        localModel.position.x,
        localModel.position.z
      )
      localModel.position.y = terrainHeight

      // Reposition camera above localModel
      const cameraOffset = new THREE.Vector3(0, 1.7, 0)
      camera.position.copy(localModel.position.clone().add(cameraOffset))

      // Broadcast
      emitMovementIfChanged({
        x: localModel.position.x,
        z: localModel.position.z,
        rotation: getCameraYaw(),
        action: currentAction
      })
    }

    // 2) RIGHT joystick for turning left/right
    if (source.handedness === 'right') {
      const { axes } = source.gamepad
      // Typically axes[0] = X for horizontal turn
      const turn = axes[0]
      const deadZone = 0.2
      if (Math.abs(turn) > deadZone) {
        // Smooth turn
        const turnDirection = Math.sign(turn) // +1 or -1
        const turnAmount = mouseSensitivity * turnDirection * delta * 100 // Adjusted for better responsiveness
        // Rotate localModel
        if (localModel) {
          localModel.rotation.y -= turnAmount
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
          action: currentAction
        })
      }
    }
  }
}

// Teleport intersection + marker
function checkTeleportIntersections() {
  INTERSECTION = null
  markerMesh.visible = false

  const session = renderer.xr.getSession()
  if (!session) return

  // For both controllers, if user isSelecting, cast a ray
  session.inputSources.forEach(source => {
    if (
      source &&
      source.targetRayMode === 'tracked-pointer' &&
      source.gamepad
    ) {
      const handedness = source.handedness
      // Grab the actual XRController object from Three.js
      const controller =
        handedness === 'left'
          ? renderer.xr.getController(0)
          : renderer.xr.getController(1)

      if (!controller.userData.isSelecting) return

      // Build a ray
      tempMatrix.identity().extractRotation(controller.matrixWorld)
      const rayOrigin = new THREE.Vector3().setFromMatrixPosition(
        controller.matrixWorld
      )
      const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix)

      // Raycast
      const raycaster = new THREE.Raycaster(rayOrigin, rayDirection, 0, 100)
      const intersects = raycaster.intersectObject(terrainMesh)
      if (intersects.length > 0) {
        INTERSECTION = intersects[0].point
        markerMesh.position.copy(INTERSECTION)
        markerMesh.visible = true
      }
    }
  })
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
/**
 * Updates the innerHTML of an element with the given ID.
 * @param {string} elementId - The ID of the HTML element to update.
 * @param {string} content - The content to set as innerHTML.
 */
function updateField(elementId, content) {
  const element = document.getElementById(elementId)
  if (!element) {
    console.warn(`Element with ID '${elementId}' not found.`)
    return
  }
  element.innerHTML = content
}

// ------------------------------
// Render loop
// ------------------------------

function animate() {
  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta()

    // 1. Update local animations
    if (localMixer) {
      localMixer.update(delta)
    }

    // 2. Update camera orientation based on device orientation data, if enabled
    if (window.isOrientationEnabled) {
      updateCameraOrientation()
    }
    // Handle resize adjustments
    if (needsResize) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
      needsResize = false;
    }
    dayNightCycle.update();

    // 3. Handle rendering and movements based on VR availability
    if (renderer.xr.isPresenting) {
      // **VR Mode**

      // Handle VR-specific movements (e.g., joystick input)
      handleVRMovement(delta)

      // Handle teleportation intersections and marker placement
      checkTeleportIntersections()

      // Ensure the camera is correctly positioned above the terrain
      const terrainHeight = getTerrainHeightAt(
        localModel.position.x,
        localModel.position.z
      )
      localModel.position.y = terrainHeight

      // **Render the scene for VR without post-processing**
      renderer.render(scene, camera)
    } else {
      // **Desktop/Mobile Mode**

      // Make the local model follow the camera's position smoothly, if it exists
      if (localModel) {
        // Ensure the camera is correctly positioned above the terrain
        const terrainHeight = getTerrainHeightAt(
          localModel.position.x,
          localModel.position.z
        )

        localModel.position.y = terrainHeight

        //updateField('position', currentPos)
        // Automatically reposition the camera 1.7 units above the closest grid point
        reportPosition()

        // Optional: Smooth camera movement (if needed)
        // camera.position.lerp(targetPosition, 0.1);
      }

      // Handle desktop-specific movements (e.g., keyboard input)
      moveLocalCharacterDesktop(delta)

      // **Render the scene with post-processing effects**
      composer.render(scene, camera)
    }

    // 4. Update remote players' animations
    Object.values(players).forEach(p => {
      p.mixer.update(delta)
    })

    // 5. Render dynamic terrain points
    renderTerrainPoints()

    // 6. Optionally, handle asynchronous line drawing
    // This can be managed via separate functions or states if needed
  })
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
// Configuration object for geographic settings
const geoConfig = {
  originLatitude: window.latitude,    // Replace with your actual origin latitude
  originLongitude: window.longitude, // Replace with your actual origin longitude
  scaleMultiplier: 1           // Adjust as needed
};
/**
 * Converts geographic coordinates to Three.js coordinates.
 * @param {number} latitude
 * @param {number} longitude
 * @returns {{x: number, z: number}}
 */
function convertGeoToThreeJS(latitude, longitude) {
  const x = (longitude - originLongitude) * 110540 * geoConfig.scaleMultiplier
  const z = (latitude - originLatitude) * 111320 * geoConfig.scaleMultiplier
  return { x, z }
}

/**
 * Converts Three.js coordinates back to geographic coordinates.
 * @param {number} x
 * @param {number} z
 * @returns {{latitude: number, longitude: number}}
 */
function convertThreeJSToGeo(x, z) {
  const latitude = z / (111320 * geoConfig.scaleMultiplier) + originLatitude
  const longitude = x / (110540 * geoConfig.scaleMultiplier) + originLongitude
  return { latitude, longitude }
}

function loadLocalModel() {
  // Check if a VR session is active; if so, do not load the local model
  if (renderer.xr.isPresenting) {
    console.log(
      'VR session active. Skipping loading of local model to prevent camera obstruction.'
    );
    return;
  }

  let finalSpawn = null;

  // Function to convert latitude and longitude to Three.js x and z coordinates
  const latLonToXZ = (latitude, longitude) => {
    const metersPerDegLat = 111320 * geoConfig.scaleMultiplier;
    const metersPerDegLon = 110540 * geoConfig.scaleMultiplier; // Ideally, adjust based on average latitude

    const x = (longitude - geoConfig.originLongitude) * metersPerDegLon;
    const z = (latitude - geoConfig.originLatitude) * metersPerDegLat;
    return { x, z };
  };

  // Check if window.latitude and window.longitude are defined
  if (
    typeof window.latitude !== 'undefined' &&
    typeof window.longitude !== 'undefined'
  ) {
    // Convert geographic coordinates to x and z
    const { x, z } = latLonToXZ(window.latitude, window.longitude);

    finalSpawn = {
      x: x,
      z: z,
      rotation: window.rotation || 0 // Optionally, use window.rotation if available
    };

    console.log(
      'Using window.latitude and window.longitude for spawn position:',
      finalSpawn
    );
  } else {
    // Fallback to loading spawn data from localStorage
    const spawnData = loadPositionFromLocalStorage();

    if (spawnData) {
      finalSpawn = spawnData;
      console.log('Loaded saved position from localStorage:', finalSpawn);
    } else {
      // If no saved position, fallback to a random spawn point
      finalSpawn = getRandomSpawnPoint();
      console.log('No saved position found; using random spawn:', finalSpawn);
    }
  }

  // Ensure finalSpawn has x and z coordinates
  if (
    !finalSpawn ||
    typeof finalSpawn.x !== 'number' ||
    typeof finalSpawn.z !== 'number'
  ) {
    console.error('Final spawn position is invalid. Aborting model loading.');
    return;
  }

  const loader = new GLTFLoader();
  loader.load(
    modelPath,
    gltf => {
      localModel = gltf.scene;

      // Set the model's position based on finalSpawn
      localModel.position.set(finalSpawn.x, 0, finalSpawn.z);

      // Set the model's rotation around the Y-axis
      localModel.rotation.y = finalSpawn.rotation || 0;

      // Add the model to the scene
      scene.add(localModel);

      // Enable shadow casting for all meshes within the model
      localModel.traverse(obj => {
        if (obj.isMesh) obj.castShadow = true;
      });

      // Setup localMixer for animations
      localMixer = new THREE.AnimationMixer(localModel);
      gltf.animations.forEach(clip => {
        const action = localMixer.clipAction(clip);
        action.loop = THREE.LoopRepeat;
        localActions[clip.name] = action;
        if (clip.name === 'idle') action.play();
      });

      // Finally, inform the server about the player joining
      socket.emit('player_joined', {
        x: finalSpawn.x,
        z: finalSpawn.z,
        rotation: finalSpawn.rotation,
        action: 'idle',
        id: myId // include localStorage ID
      });
    },
    undefined,
    err => console.error('Error loading local model:', err)
  );
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

  /**
   * Handle 'position' event: Receive encrypted position data from a player
   */
  socket.on('position', async (data) => {
    const { id, encryptedPosition } = data;
    console.log(`[Socket] position => Received encrypted position from ID: ${id}`);

    // Retrieve the password from localStorage
    const password = loadPassword();
    if (!password) {
      console.error('Password not found. Cannot decrypt position data.');
      return;
    }

    try {
      // Decrypt the received data
      const decryptedData = await decryptLatLon(encryptedPosition, password);
      if (decryptedData) {
        const { latitude, longitude } = decryptedData;
        console.log(`[Socket] position => Decrypted Position from ID: ${id}: Lat=${latitude}, Lon=${longitude}`);

        // Map latitude and longitude to your game's coordinate system
        const x = mapLongitudeToX(longitude);
        const z = mapLatitudeToZ(latitude);

        // Update the player's position in your game
        if (players[id]) {
          // Assuming players[id].position is a THREE.Vector3
          players[id].position.set(x, getTerrainHeightAt(x, z), z);
          players[id].model.position.lerp(players[id].position, 0.1); // Smooth transition
        } else {
          console.warn(`[Socket] position => Player with ID: ${id} not found.`);
        }
      } else {
        console.warn(`[Socket] position => Failed to decrypt position data from ID: ${id}.`);
      }
    } catch (error) {
      console.error(`[Socket] position => Error decrypting position data from ID: ${id}:`, error);
    }
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
      const terrainHeight = getTerrainHeightAt(
        data.x,
        data.z
      )
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



/**
 * Normalizes an angle to the range of -PI to PI radians.
 * @param {number} angle - The angle in radians to normalize.
 * @returns {number} - The normalized angle within [-PI, PI].
 */

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

  const terrainHeight = getTerrainHeightAt(
    data.x,
    data.z
  )
  if (!player.initialized) {
    player.model.position.set(data.x, terrainHeight, data.z)
    player.model.rotation.y = data.rotation
    player.initialized = true
    return
  }
  player.position.set(data.x, terrainHeight, data.z)
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

let needsResize = false;


function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio); // Add this
  needsResize = true;

}

// ------------------------------
// Permission Handling
// ------------------------------

// Check Permissions and Initialize Listeners
function checkPermissions() {
  if (window.appPermissions) {
    const { motionGranted, orientationGranted, locationGranted } =
      window.appPermissions
    console.log('Accessing Global Permissions:', window.appPermissions)

    // Modify behavior based on permissions
    if (motionGranted) {
      console.log('Motion permissions granted.')
      enableMotionFeatures()
    } else {
      console.log('Motion permissions denied.')
      disableMotionFeatures()
    }

    if (orientationGranted) {
      console.log('Orientation permissions granted.')
      enableOrientationFeatures()
    } else {
      console.log('Orientation permissions denied.')
      disableOrientationFeatures()
    }

    if (locationGranted) {
      console.log('Location permissions granted.')
      initializeLocationFeatures()
    } else {
      console.log('Location permissions denied.')
      disableLocationFeatures()
    }

    // Initialize sensor listeners after checking permissions
    initializeSensorListeners()
  } else {
    console.log('Permissions not yet set.')
    // Optionally, you can create a generic overlay prompting the user to grant all permissions
    //createGenericPermissionOverlay()
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



// Utility Functions

/**
 * Converts an ArrayBuffer to a Base64 string.
 * @param {ArrayBuffer} buffer - The buffer to convert.
 * @returns {string} - The Base64 encoded string.
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return window.btoa(binary);
}

/**
* Converts a Base64 string to an ArrayBuffer.
* @param {string} base64 - The Base64 string to convert.
* @returns {ArrayBuffer} - The resulting ArrayBuffer.
*/
function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  Array.from(binary).forEach((char, i) => {
    bytes[i] = char.charCodeAt(0);
  });
  return bytes.buffer;
}
/**
 * Maps latitude to the game's Z-coordinate.
 * @param {number} latitude - The latitude value.
 * @returns {number} - The corresponding Z-coordinate in the game world.
 */
function mapLatitudeToZ(latitude) {
  // Implement your mapping logic here
  // Example: Each degree latitude equals 100 units in Z-axis
  const scale = 100; // Adjust based on your terrain size
  const referenceLatitude = 0; // Replace with your reference point
  return (latitude - referenceLatitude) * scale;
}

/**
 * Maps longitude to the game's X-coordinate.
 * @param {number} longitude - The longitude value.
 * @returns {number} - The corresponding X-coordinate in the game world.
 */
function mapLongitudeToX(longitude) {
  // Implement your mapping logic here
  // Example: Each degree longitude equals 100 units in X-axis
  const scale = 100; // Adjust based on your terrain size
  const referenceLongitude = 0; // Replace with your reference point
  return (longitude - referenceLongitude) * scale;
}
// Helper Functions for Password Management

/**
* Saves the password to localStorage.
* @param {string} password - The password to save.
*/
function savePassword(password) {
  localStorage.setItem('encryptedPassword', password);
}

/**
* Loads the password from localStorage.
* @returns {string} - The loaded password or an empty string if not found.
*/
function loadPassword() {
  return localStorage.getItem('encryptedPassword') || '';
}

/**
* Clears the password from localStorage.
*/
function clearPassword() {
  localStorage.removeItem('encryptedPassword');
}

// Encryption Function

/**
* Encrypts latitude and longitude data using a password.
* @param {number} latitude - The latitude value.
* @param {number} longitude - The longitude value.
* @param {string} password - The password for encryption.
* @returns {Promise<string>} - A JSON string containing the encrypted data, IV, and salt.
*/
async function encryptLatLon(latitude, longitude, password) {
  // 1. Serialize the data
  const data = JSON.stringify({ latitude, longitude });
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);

  // 2. Generate a random salt
  const salt = window.crypto.getRandomValues(new Uint8Array(16));

  // 3. Derive a key from the password and salt
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const key = await window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  // 4. Generate a random IV
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  // 5. Encrypt the data
  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    dataBuffer
  );

  // 6. Package the encrypted data with salt and iv for transmission/storage
  const encryptedPackage = {
    ciphertext: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer),
    salt: arrayBufferToBase64(salt.buffer)
  };

  return JSON.stringify(encryptedPackage);
}

// Decryption Function

/**
* Decrypts the encrypted latitude and longitude data using a password.
* @param {string} encryptedPackageStr - The JSON string containing encrypted data, IV, and salt.
* @param {string} password - The password for decryption.
* @returns {Promise<{latitude: number, longitude: number} | null>} - The decrypted lat/lon data or null if decryption fails.
*/
async function decryptLatLon(encryptedPackageStr, password) {
  const decoder = new TextDecoder();

  // 1. Parse the encrypted package
  const encryptedPackage = JSON.parse(encryptedPackageStr);
  const ciphertext = base64ToArrayBuffer(encryptedPackage.ciphertext);
  const iv = base64ToArrayBuffer(encryptedPackage.iv);
  const salt = base64ToArrayBuffer(encryptedPackage.salt);

  // 2. Derive the key from the password and salt
  const encoder = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const key = await window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  try {
    // 3. Decrypt the data
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(iv)
      },
      key,
      ciphertext
    );

    // 4. Decode the decrypted data
    const decryptedData = decoder.decode(decryptedBuffer);
    const { latitude, longitude } = JSON.parse(decryptedData);

    return { latitude, longitude };
  } catch (e) {
    console.error('Decryption failed:', e);
    return null;
  }
}


// Function to convert latitude and longitude to Three.js x and z coordinates
const latLonToXZ = (latitude, longitude) => {
  const x = (longitude - origin.longitude) * metersPerDegLon;
  const z = (latitude - origin.latitude) * metersPerDegLat;
  return { x, z };
};
// Dedicated Function: Encrypt and Emit Lat/Lon Data

/**
* Retrieves latitude and longitude from the global window object and password from localStorage,
* then encrypts and emits the data via Socket.IO.
*/
async function encryptAndEmitLatLon() {
  // 1. Retrieve latitude and longitude from the window object
  const { latitude, longitude } = window;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    console.error('window.latitude and window.longitude must be set to numerical values.');
    return;
  }

  // 2. Retrieve the password from localStorage
  const password = loadPassword();
  if (!password) {
    console.error('Password not found. Please enter a password.');
    return;
  }

  try {
    // 3. Encrypt the lat/lon data
    const encryptedPackageStr = await encryptLatLon(latitude, longitude, password);
    console.log('Encrypted Package:', encryptedPackageStr);

    // 4. Emit the encrypted data via Socket.IO
    socket.emit('position', encryptedPackageStr);
  } catch (error) {
    console.error('Encryption failed:', error);
  }
}

// Event Listener for the Encrypt & Decrypt Button

document.getElementById('encryptDecryptBtn').addEventListener('click', async () => {
  const passwordInput = document.getElementById('password');
  const password = passwordInput.value.trim();

  if (!password) {
    console.error('Password cannot be empty.');
    document.getElementById('encryptDecryptBtn').innerHTML = "Password cannot be empty."
    return;
  }

  // Save the password to localStorage
  savePassword(password);

  // Encrypt and emit the current lat/lon data
  await encryptAndEmitLatLon();
});

// Event Listener for Password Input Changes
// This will re-encrypt and emit data whenever the password is updated

document.getElementById('password').addEventListener('change', async () => {
  const passwordInput = document.getElementById('password');
  const newPassword = passwordInput.value.trim();

  if (!newPassword) {
    console.error('Password cannot be empty.');
    return;
  }

  // Save the new password to localStorage
  savePassword(newPassword);

  // Re-encrypt and emit the current lat/lon data with the new password
  await encryptAndEmitLatLon();
});

// Load Password from localStorage on Page Load and Populate the Password Input

window.addEventListener('DOMContentLoaded', () => {
  const passwordInput = document.getElementById('password');
  const savedPassword = loadPassword();
  if (savedPassword) {
    passwordInput.value = savedPassword;
  }
});
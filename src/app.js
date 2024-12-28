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

import { io } from 'https://cdn.socket.io/4.4.1/socket.io.esm.min.js'
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
const runSpeed = 5

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
function initializeSensorListeners () {
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
function handleOrientation (event) {
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
function handleMotion (event) {
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
function init () {
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
  scene.background = new THREE.Color(0x555555)
  scene.fog = new THREE.Fog(0x555555, 45, 100)

  // Camera
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    1,
    100
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

  // Lights
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5)
  hemiLight.position.set(0, 50, 0)
  scene.add(hemiLight)

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
  dirLight.position.set(10, 50, 10)
  dirLight.castShadow = true
  dirLight.shadow.mapSize.set(1024, 1024)
  scene.add(dirLight)

  // Floor (teleport)
  floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x0ffffff,
      transparent: true,
      opacity: 0
    })
  )
  floorMesh.name = 'teleport_floor'
  scene.add(floorMesh)

  // Teleport marker
  markerMesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.25, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xbcbcbc })
  )
  markerMesh.visible = false
  scene.add(markerMesh)

  // Pointer Lock Controls (Desktop)
  controls = new PointerLockControls(camera, document.body)

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

  // postprocessing

  composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))


  const effectFilm = new FilmPass( 0.35 );
  composer.addPass( effectFilm );
  

  const effect2 = new ShaderPass(RGBShiftShader)
  effect2.uniforms['amount'].value = 0.0015
  composer.addPass(effect2)

  const effect3 = new OutputPass()
  composer.addPass(effect3)

  //

  // Setup VR controllers
  setupVRControllers()

  // Generate terrain
  generateTerrain()

 // Detect if the browser supports WebXR and has VR capabilities
 if (navigator.xr) {
    navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
      if (!supported) {
        // If VR is not supported, load the local model
        loadLocalModel()
      } else {
        console.log('VR is supported. Local model will not be loaded initially.')
      }
    })
  } else {
    // If WebXR is not available, load the local model
    loadLocalModel()
  }

  // Add event listeners for VR session start and end
  renderer.xr.addEventListener('sessionstart', () => {
    console.log('VR session started.')
    unloadLocalModel()
  })

  renderer.xr.addEventListener('sessionend', () => {
    console.log('VR session ended.')
    loadLocalModel()
  })

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
}

// ------------------------------
// Save + Load local position
// ------------------------------
function savePositionToLocalStorage () {
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

function loadPositionFromLocalStorage () {
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
function maybeSavePositionToLocalStorage () {
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
function enablePointerLock () {
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
function setupVRControllers () {
  const controller1 = renderer.xr.getController(0)
  const controller2 = renderer.xr.getController(1)

  function onSelectStart () {
    this.userData.isSelecting = true
  }
  function onSelectEnd () {
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
    const teleportSpaceOffset =
      baseReferenceSpace.getOffsetReferenceSpace(transform)
    renderer.xr.setReferenceSpace(teleportSpaceOffset)

    // Move localModel
    localModel.position.set(
      INTERSECTION.x,
      localModel.position.y,
      INTERSECTION.z
    )
    emitMovementIfChanged({
      x: localModel.position.x,
      z: localModel.position.z,
      rotation: localModel.rotation.y,
      action: currentAction
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

function buildControllerRay (data) {
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
function onKeyDown (e) {
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

function onKeyUp (e) {
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

function handleKeyStates () {
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
function moveLocalCharacterDesktop (delta) {
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

// ------------------------------
// VR Movement
// ------------------------------

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
            localModel.position.add(movement);

            // Reposition camera above localModel
            const cameraOffset = new THREE.Vector3(0, 1.7, 0);
            camera.position.copy(localModel.position).add(cameraOffset);

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
                const turnAmount = smoothTurnSpeed * turnDirection * delta;
                // Rotate localModel
                if (localModel) {
                    localModel.rotation.y -= turnAmount; 
                    // (negative sign so that pushing right rotates user to the right, adjust if necessary)
                }
                // If you want to broadcast orientation:
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
function getCameraYaw () {
  const euler = new THREE.Euler()
  euler.setFromQuaternion(camera.quaternion, 'YXZ')
  return euler.y
}

// ------------------------------
// Add `myId` to all emits
// ------------------------------
function emitMovementIfChanged (newState) {
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
  
      // 3. Handle movement based on current mode (VR or Desktop)
      if (renderer.xr.isPresenting) {
        // **VR Mode**
        
        // Handle VR-specific movements (e.g., joystick input)
        handleVRMovement(delta);
        
        // Handle teleportation intersections and marker placement
        checkTeleportIntersections();
  
        // **Render the scene for VR**
        renderer.render(scene, camera);
      } else if (localModel) {
        // **Desktop/Mobile Mode**
        
        // Make the local model follow the camera's position smoothly
        localModel.position.lerp(camera.position.clone().setY(0), 0.1);
        localModel.rotation.y = camera.rotation.y;
  
        // Handle desktop-specific movements (e.g., keyboard input)
        moveLocalCharacterDesktop(delta);
  
        // **Render the scene with post-processing effects**
        composer.render(scene, camera);
      }
  
      // 4. Update remote players' animations
      Object.values(players).forEach(p => {
        p.mixer.update(delta);
      });
    });
  }
  

// ------------------------------
// Update Camera Orientation Based on Device Orientation
// ------------------------------
function updateCameraOrientation () {
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
function loadLocalModel () {
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
        localModel.position.set(finalSpawn.x, 0, finalSpawn.z)
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
function unloadLocalModel () {
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
function generateTerrain () {
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

  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const currentVertex = vertexIndices[i][j]
      if (!currentVertex) continue

      const rightVertex = vertexIndices[i][j + 1]
      const bottomVertex = vertexIndices[i + 1]
        ? vertexIndices[i + 1][j]
        : undefined

      const baseIndex = currentVertex.index * 3
      const x0 = pointsByRange[currentVertex.rangeIndex][baseIndex + 0]
      const y0 = pointsByRange[currentVertex.rangeIndex][baseIndex + 1]
      const z0 = pointsByRange[currentVertex.rangeIndex][baseIndex + 2]

      if (rightVertex && currentVertex.rangeIndex === rightVertex.rangeIndex) {
        const baseRight = rightVertex.index * 3
        const x1 = pointsByRange[rightVertex.rangeIndex][baseRight + 0]
        const y1 = pointsByRange[rightVertex.rangeIndex][baseRight + 1]
        const z1 = pointsByRange[rightVertex.rangeIndex][baseRight + 2]
        linesByRange[currentVertex.rangeIndex].push(x0, y0, z0, x1, y1, z1)
      }
      if (
        bottomVertex &&
        currentVertex.rangeIndex === bottomVertex.rangeIndex
      ) {
        const baseDown = bottomVertex.index * 3
        const x2 = pointsByRange[bottomVertex.rangeIndex][baseDown + 0]
        const y2 = pointsByRange[bottomVertex.rangeIndex][baseDown + 1]
        const z2 = pointsByRange[bottomVertex.rangeIndex][baseDown + 2]
        linesByRange[currentVertex.rangeIndex].push(x0, y0, z0, x2, y2, z2)
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
        color:0xffffff,
        size: distanceRanges[k].pointSize,
        transparent: true,
        opacity: 0.8
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
        opacity: distanceRanges[k].lineOpacity * 0.8
      })

      const terrainLines = new THREE.LineSegments(lineGeometry, lineMaterial)
      scene.add(terrainLines)
    }
  }
}

// ------------------------------
// setLocalAction: crossfade
// ------------------------------
function setLocalAction (name, direction = 'forward') {
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
function setupSocketEvents () {
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

function addOrUpdatePlayer (id, data) {
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

function createRemotePlayer (id, data) {
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
      remoteModel.position.set(data.x, 0, data.z)
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
function normalizeAngle (angle) {
  angle = angle % (2 * Math.PI)
  if (angle < 0) {
    angle += 2 * Math.PI
  }
  return angle
}

// 2) Lerp angles using the shortest path
function lerpAngle (currentAngle, targetAngle, alpha) {
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
function updateRemotePlayer (id, data) {
  const player = players[id]
  if (!player) return

  if (!player.initialized) {
    player.model.position.set(data.x, 0, data.z)
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

function removeRemotePlayer (id) {
  if (players[id]) {
    scene.remove(players[id].model)
    delete players[id]
  }
  removeRemoteAudioStream(id)
}

function updatePlayers (playersData) {
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
function handleUserInteraction () {
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

async function startBroadcast () {
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

function stopBroadcast () {
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

function addRemoteAudioStream (id) {
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

function removeRemoteAudioStream (id) {
  const remoteAudio = remoteAudioStreams[id]
  if (remoteAudio) {
    remoteAudio.positionalAudio.stop()
    remoteAudio.positionalAudio.disconnect()
    remoteAudio.positionalAudio = null
    delete remoteAudioStreams[id]
  }
}

function receiveAudioStream (id, audioBuffer) {
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
function getRandomSpawnPoint () {
  const x = (Math.random() - 0.5) * 50
  const z = (Math.random() - 0.5) * 50
  const rotation = Math.random() * Math.PI * 2
  return { x, z, rotation }
}

function onWindowResize () {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

// Check Permissions and Initialize Listeners
function checkPermissions () {
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
  }
}

// Example functions to enable/disable features based on permissions
function enableMotionFeatures () {
  // Add or activate motion-related event listeners or controls
  if (window.appPermissions.motionGranted) {
    window.addEventListener('devicemotion', handleMotion)
  }
}

function disableMotionFeatures () {
  // Remove or deactivate motion-related event listeners or controls
  window.removeEventListener('devicemotion', handleMotion)
}

function enableOrientationFeatures () {
  // Enable orientation-specific functionalities
  if (window.appPermissions.orientationGranted) {
    window.addEventListener('deviceorientation', handleOrientation)
  }
}

function disableOrientationFeatures () {
  // Disable orientation-specific functionalities
  window.removeEventListener('deviceorientation', handleOrientation)
}

function initializeLocationFeatures () {
  // Initialize features that rely on location data
  console.log('Initializing location-based features.')
}

function disableLocationFeatures () {
  // Disable or adjust features that rely on location data
  console.log('Disabling location-based features.')
}

// Listen for changes in permissions
window.addEventListener('appPermissionsChanged', () => {
  checkPermissions()
})

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

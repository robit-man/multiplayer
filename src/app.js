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
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import { SSAARenderPass } from 'three/addons/postprocessing/SSAARenderPass.js'
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js'
import Stats from 'three/addons/libs/stats.module.js'

import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { io } from 'https://cdn.socket.io/4.4.1/socket.io.esm.min.js'
import SimplexNoise from 'https://cdn.jsdelivr.net/npm/simplex-noise@3.0.0/dist/esm/simplex-noise.min.js'
import SunCalc from 'suncalc'

// Determine modelPath based on file existence
const modelPathDir = fileExists('/public/Xbot.glb')
  ? '/public/Xbot.glb'
  : '/Xbot.glb'

// Determine fontPath based on file existence
const fontPathDir = fileExists('/public/uno.ttf')
  ? '/public/uno.ttf'
  : '/uno.ttf'

/**
 * Checks synchronously if a file exists at the specified path.
 * @param {string} path - The path to the file.
 * @returns {boolean} - Returns true if the file exists, false otherwise.
 */
function fileExists(path) {
  const xhr = new XMLHttpRequest()
  try {
    xhr.open('HEAD', path, false) // false for synchronous request
    xhr.send()
    return xhr.status !== 404
  } catch (e) {
    console.error(`Error checking existence of ${path}:`, e)
    return false
  }
}

// ------------------------------
// Configuration Object
// ------------------------------
const CONFIG = {
  socketURL: 'https://full-canary-chokeberry.glitch.me/',
  modelPath: modelPathDir,
  fontPath: fontPathDir,
  terrain: {
    size: 100,
    segments: 100,
    scaleMultiplier: 1,
    gridSizeMeters: 250,
    gridResolution: 100,
    elevationAPI: 'https://epqs.nationalmap.gov/v1/json'
  },
  postProcessing: {
    enableFilmPass: false,
    enableRGBShift: false,
    enableFXAAPass: false,
    enableSSAARenderPass: false
  },
  permissions: {
    motionGranted: false,
    orientationGranted: false,
    locationGranted: false
  },
  audio: {
    broadcastKey: 'audio_stream',
    startBroadcastKey: 'start_audio',
    stopBroadcastKey: 'stop_audio'
  },
  localStorageKeys: {
    playerID: null,
    lastPosition: 'myLastPosition',
    terrainPoints: 'terrainPoints',
    encryptedPassword: 'encryptedPassword'
  },
  motionVars: {
    walkSpeed: 2,
    runSpeed: 7
  }
}

// ------------------------------
// Utilities Module
// ------------------------------
class Utils {
  static normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle))
  }

  static lerpAngle(currentAngle, targetAngle, alpha) {
    currentAngle = Utils.normalizeAngle(currentAngle)
    targetAngle = Utils.normalizeAngle(targetAngle)

    let diff = targetAngle - currentAngle
    if (diff > Math.PI) {
      diff -= 2 * Math.PI
    } else if (diff < -Math.PI) {
      diff += 2 * Math.PI
    }
    const newAngle = currentAngle + diff * alpha
    return Utils.normalizeAngle(newAngle)
  }

  static arrayBufferToBase64(buffer) {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    bytes.forEach(b => (binary += String.fromCharCode(b)))
    return window.btoa(binary)
  }

  static base64ToArrayBuffer(base64) {
    const binary = window.atob(base64)
    const bytes = new Uint8Array(binary.length)
    Array.from(binary).forEach((char, i) => {
      bytes[i] = char.charCodeAt(0)
    })
    return bytes.buffer
  }

  static calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3 // Earth radius in meters
    const phi1 = THREE.MathUtils.degToRad(lat1)
    const phi2 = THREE.MathUtils.degToRad(lat2)
    const deltaPhi = THREE.MathUtils.degToRad(lat2 - lat1)
    const deltaLambda = THREE.MathUtils.degToRad(lon2 - lon1)

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLambda / 2) *
      Math.sin(deltaLambda / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

    const distance = R * c
    return distance
  }

  static mapLatitudeToZ(latitude, originLatitude, scale) {
    return (latitude - originLatitude) * (111320 * scale)
  }

  static mapLongitudeToX(longitude, originLongitude, scale) {
    return (longitude - originLongitude) * (110540 * scale)
  }

  static calculateDistanceSq(x1, z1, x2, z2) {
    const dx = x1 - x2
    const dz = z1 - z2
    return dx * dx + dz * dz
  }
}

// ------------------------------
// Encryption Module
// ------------------------------
class Encryption {
  /**
   * Encrypts latitude and longitude data using a password.
   * @param {number} latitude - The latitude value.
   * @param {number} longitude - The longitude value.
   * @param {string} password - The password for encryption.
   * @returns {Promise<string>} - A JSON string containing the encrypted data, IV, and salt.
   */
  static async encryptLatLon(latitude, longitude, password) {
    const data = JSON.stringify({ latitude, longitude })
    const encoder = new TextEncoder()
    const dataBuffer = encoder.encode(data)

    const salt = window.crypto.getRandomValues(new Uint8Array(16))

    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )

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
    )

    const iv = window.crypto.getRandomValues(new Uint8Array(12))

    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      key,
      dataBuffer
    )

    const encryptedPackage = {
      ciphertext: Utils.arrayBufferToBase64(encrypted),
      iv: Utils.arrayBufferToBase64(iv.buffer),
      salt: Utils.arrayBufferToBase64(salt.buffer)
    }

    return JSON.stringify(encryptedPackage)
  }

  /**
   * Decrypts the encrypted latitude and longitude data using a password.
   * @param {string} encryptedPackageStr - The JSON string containing encrypted data, IV, and salt.
   * @param {string} password - The password for decryption.
   * @returns {Promise<{latitude: number, longitude: number} | null>} - The decrypted lat/lon data or null if decryption fails.
   */
  static async decryptLatLon(encryptedPackageStr, password) {
    const decoder = new TextDecoder()

    const encryptedPackage = JSON.parse(encryptedPackageStr)
    const ciphertext = Utils.base64ToArrayBuffer(encryptedPackage.ciphertext)
    const iv = Utils.base64ToArrayBuffer(encryptedPackage.iv)
    const salt = Utils.base64ToArrayBuffer(encryptedPackage.salt)

    const encoder = new TextEncoder()
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )

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
    )

    try {
      const decryptedBuffer = await window.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(iv)
        },
        key,
        ciphertext
      )

      const decryptedData = decoder.decode(decryptedBuffer)
      const { latitude, longitude } = JSON.parse(decryptedData)

      return { latitude, longitude }
    } catch (e) {
      console.error('Decryption failed:', e)
      return null
    }
  }
}

// ------------------------------
// Storage Module
// ------------------------------
class Storage {
  /**
   * Saves a key-value pair to localStorage.
   * @param {string} key - The key under which to store the data.
   * @param {*} value - The data to store.
   */
  static save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (e) {
      console.error(`Failed to save ${key} to localStorage:`, e)
    }
  }

  /**
   * Loads a value from localStorage.
   * @param {string} key - The key of the data to retrieve.
   * @returns {*} - The retrieved data or null if not found.
   */
  static load(key) {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch (e) {
      console.warn(`Error parsing ${key} from localStorage:`, e)
      return null
    }
  }

  /**
   * Removes a key-value pair from localStorage.
   * @param {string} key - The key to remove.
   */
  static remove(key) {
    try {
      localStorage.removeItem(key)
    } catch (e) {
      console.error(`Failed to remove ${key} from localStorage:`, e)
    }
  }
}

class Sensors {
  static orientationData = {
    alpha: null,
    beta: null,
    gamma: null,
    webkitCompassHeading: undefined,
    webkitCompassAccuracy: undefined
  }

  static isOrientationEnabled = false
  static isMotionEnabled = false

  /**
   * Initializes sensor event listeners based on permissions.
   * Requests permissions via user gesture (e.g., tap on #app).
   */
  static async initialize() {
    try {
      console.log('Initializing Sensors...')

      // Request orientation permission if needed
      const orientationGranted = await Sensors.requestOrientationPermission()
      console.log(`Orientation permission granted: ${orientationGranted}`)

      // Request motion permission if needed (for iOS 13+)
      const motionGranted = await Sensors.requestMotionPermission()
      console.log(`Motion permission granted: ${motionGranted}`)

      // Attach event listeners based on granted permissions
      if (orientationGranted) {
        window.addEventListener('deviceorientation', Sensors.handleOrientation)
        Sensors.isOrientationEnabled = true
        console.log('DeviceOrientation event listener added.')
        //alert('Device Orientation enabled.')
      } else {
        console.warn('DeviceOrientation permission not granted.')
        alert('Device Orientation permission denied.')
      }

      if (motionGranted) {
        window.addEventListener('devicemotion', Sensors.handleMotion)
        Sensors.isMotionEnabled = true
        console.log('DeviceMotion event listener added.')
        //alert('Device Motion enabled.')
      } else {
        console.warn('DeviceMotion permission not granted.')
        alert('Device Motion permission denied.')
      }
    } catch (err) {
      console.error('Error initializing Sensors:', err)
      alert('Error initializing sensors. Please try again.')
    }
  }

  /**
   * Requests device orientation permission (required for iOS 13+)
   * @returns {Promise<boolean>} - Resolves to true if permission is granted
   */
  static requestOrientationPermission() {
    return new Promise((resolve, reject) => {
      // Check if permission is needed (iOS 13+)
      if (
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function'
      ) {
        console.log('Requesting Device Orientation permission...')
        DeviceOrientationEvent.requestPermission()
          .then(response => {
            if (response === 'granted') {
              resolve(true)
            } else {
              resolve(false)
            }
          })
          .catch(error => {
            console.error('Error requesting DeviceOrientation permission:', error)
            resolve(false)
          })
      } else {
        // Permission not required
        console.log('DeviceOrientation permission not required.')
        resolve(true)
      }
    })
  }

  /**
   * Requests device motion permission (required for iOS 13+)
   * @returns {Promise<boolean>} - Resolves to true if permission is granted
   */
  static requestMotionPermission() {
    return new Promise((resolve, reject) => {
      // Check if permission is needed (iOS 13+)
      if (
        typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function'
      ) {
        console.log('Requesting Device Motion permission...')
        DeviceMotionEvent.requestPermission()
          .then(response => {
            if (response === 'granted') {
              resolve(true)
            } else {
              resolve(false)
            }
          })
          .catch(error => {
            console.error('Error requesting DeviceMotion permission:', error)
            resolve(false)
          })
      } else {
        // Permission not required
        console.log('DeviceMotion permission not required.')
        resolve(true)
      }
    })
  }

  /**
   * Handles device orientation events.
   * @param {DeviceOrientationEvent} event
   */
  static handleOrientation(event) {
    try {
      Sensors.orientationData.alpha =
        event.alpha !== null ? event.alpha : Sensors.orientationData.alpha
      Sensors.orientationData.beta =
        event.beta !== null ? event.beta : Sensors.orientationData.beta
      Sensors.orientationData.gamma =
        event.gamma !== null ? event.gamma : Sensors.orientationData.gamma

      if (event.webkitCompassHeading !== undefined) {
        Sensors.orientationData.webkitCompassHeading =
          event.webkitCompassHeading
        Sensors.orientationData.webkitCompassAccuracy =
          event.webkitCompassAccuracy
      }

      // Log the updated orientation data for debugging
      console.log(
        `Orientation Updated - Alpha: ${Sensors.orientationData.alpha}, Beta: ${Sensors.orientationData.beta}, Gamma: ${Sensors.orientationData.gamma}`
      )
    } catch (err) {
      console.error('Error in handleOrientation:', err)
      alert('Error handling orientation data.')
    }
  }

  /**
   * Handles device motion events.
   * @param {DeviceMotionEvent} event
   */
  static handleMotion(event) {
    try {
      // Implement motion data handling as needed
      console.log('DeviceMotionEvent:', event)
    } catch (err) {
      console.error('Error in handleMotion:', err)
      alert('Error handling motion data.')
    }
  }
}


// ------------------------------
// UI Module
// ------------------------------
class UI {
  /**
   * Updates the innerHTML of an element with the given ID.
   * @param {string} elementId - The ID of the HTML element to update.
   * @param {string} content - The content to set as innerHTML.
   */
  static updateField(elementId, content) {
    const element = document.getElementById(elementId)
    //console.log(`Element with ID '${elementId}' Update with '${content}'`);
    if (!element) {
      //console.warn(`Element with ID '${elementId}' not found.`);
      return
    }
    element.innerHTML = content
  }

  /**
   * Updates the innerHTML of an element if the value is not null.
   * @param {string} elementId - The ID of the HTML element to update.
   * @param {number} value - The numerical value to display.
   * @param {number} decimals - Number of decimal places.
   */
  static updateFieldIfNotNull(elementId, value, decimals) {
    if (value !== null && value !== undefined) {
      const formattedValue = value.toFixed(decimals)
      UI.updateField(elementId, formattedValue)
    }
  }

  /**
   * Increments an event count display for debugging purposes.
   */
  static incrementEventCount() {
    const countElement = document.getElementById('eventCount')
    if (!countElement) return
    const currentCount = parseInt(countElement.innerHTML) || 0
    countElement.innerHTML = currentCount + 1
  }
}

// ------------------------------
// DayNightCycle Class
// ------------------------------
class DayNightCycle {
  constructor(scene, options = {}) {
    this.scene = scene

    // Default options (can be overridden)
    this.options = {
      skyScale: 450000,
      directionalLightColor: 0xffffff,
      directionalLightIntensityDay: 1,
      directionalLightIntensityNight: 0.1,
      directionalLightPosition: new THREE.Vector3(0, 200, -200),
      directionalLightTarget: new THREE.Vector3(-5, 0, 0),
      shadowMapSize: new THREE.Vector2(1024, 1024),
      skyTurbidity: 0.8,
      skyRayleigh: 0.2,
      skyMieCoefficient: 0.005,
      skyMieDirectionalG: 0.6,
      ambientLightColor: 0xffffff,
      ambientLightIntensityDay: 0.8,
      ambientLightIntensityNight: 0.5,
      transitionSpeed: 0.01, // Speed of transitions
      updateInterval: 60 * 1000 // Update every minute
    }

    Object.assign(this.options, options)

    // Initialize components
    this.initDirectionalLight()
    this.initSky()
    this.initAmbientLight()

    // Initialize location and time-dependent data
    this.latitude = window.latitude || null
    this.longitude = window.longitude || null
    this.sunrise = 8
    this.sunset = 18

    // For smooth transitions
    this.currentAmbientIntensity = this.options.ambientLightIntensityNight
    this.currentDirLightIntensity = this.options.directionalLightIntensityNight

    // Start the initialization process
    this.initLocation()
  }

  initLocation() {
    if (this.latitude === null || this.longitude === null) {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          position => {
            window.latitude = position.coords.latitude
            window.longitude = position.coords.longitude
            this.latitude = window.latitude
            this.longitude = window.longitude
            this.calculateSunTimes()
            this.updateSunPosition() // Set initial sun position based on current time and location

            // Optionally, set an interval to update sun times daily
            setInterval(() => {
              this.calculateSunTimes()
            }, 24 * 60 * 60 * 1000) // Every 24 hours
          },
          error => {
            console.error('Geolocation error:', error)
            // Fallback to default sunrise and sunset times if location is unavailable
            this.latitude = 0
            this.longitude = 0
            this.setDefaultSunTimes()
            this.updateSunPosition()
          }
        )
      } else {
        console.error('Geolocation not supported.')
        // Fallback to default sunrise and sunset times if geolocation is not supported
        this.latitude = 0
        this.longitude = 0
        this.setDefaultSunTimes()
        this.updateSunPosition()
      }
    } else {
      this.calculateSunTimes()
      this.updateSunPosition()
    }
  }

  setDefaultSunTimes() {
    // Default sunrise and sunset times (e.g., 6 AM and 6 PM)
    const now = new Date()
    this.sunrise = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      6,
      0,
      0
    )
    this.sunset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      18,
      0,
      0
    )
  }

  calculateSunTimes() {
    if (!this.latitude || !this.longitude) {
      console.warn('Latitude and Longitude are not set.')
      this.setDefaultSunTimes()
      return
    }

    const now = new Date()
    const times = SunCalc.getTimes(now, this.latitude, this.longitude)

    this.sunrise = times.sunrise
    this.sunset = times.sunset

    // Optional: Log the times for debugging
    console.log('Sunrise:', this.sunrise)
    console.log('Sunset:', this.sunset)
  }

  initDirectionalLight() {
    // Create Directional Light
    this.dirLight = new THREE.DirectionalLight(
      this.options.directionalLightColor,
      this.options.directionalLightIntensityNight
    )
    this.dirLight.position.copy(this.options.directionalLightPosition)
    this.dirLight.castShadow = true
    this.dirLight.target.position.copy(this.options.directionalLightTarget)
    this.dirLight.shadow.mapSize.copy(this.options.shadowMapSize)
    this.scene.add(this.dirLight)
    this.scene.add(this.dirLight.target) // Ensure the target is added to the scene
  }

  initSky() {
    // Initialize Sky
    this.sky = new Sky()
    this.sky.scale.setScalar(this.options.skyScale)
    this.scene.add(this.sky)

    // Configure Sky Parameters
    this.skyUniforms = this.sky.material.uniforms

    this.skyUniforms['turbidity'].value = this.options.skyTurbidity
    this.skyUniforms['rayleigh'].value = this.options.skyRayleigh
    this.skyUniforms['mieCoefficient'].value = this.options.skyMieCoefficient
    this.skyUniforms['mieDirectionalG'].value = this.options.skyMieDirectionalG

    this.sun = new THREE.Vector3()
    this.skyUniforms['sunPosition'].value.copy(this.sun)
  }

  initAmbientLight() {
    // Add Ambient Light
    this.ambientLight = new THREE.AmbientLight(
      this.options.ambientLightColor,
      this.options.ambientLightIntensityNight
    )
    this.scene.add(this.ambientLight)
  }

  updateSunPosition() {
    if (!this.sunrise || !this.sunset) {
      console.warn('Sunrise and sunset times are not set.')
      return
    }

    const now = new Date()

    // Determine if it's day or night
    const isDay = now >= this.sunrise && now < this.sunset

    let elevation
    let azimuth

    if (isDay) {
      // Calculate the progress of the day (0 at sunrise, 1 at sunset)
      const dayDuration = (this.sunset - this.sunrise) / (1000 * 60 * 60) // Duration in hours
      const timeSinceSunrise = (now - this.sunrise) / (1000 * 60 * 60) // Hours since sunrise
      const dayProgress = timeSinceSunrise / dayDuration // 0 to 1

      elevation = dayProgress * 90 // From 0° (horizon) to 90° (zenith)
      azimuth = 180 // Adjust as needed for sun's path

      // Smoothly interpolate ambient light intensity
      this.currentAmbientIntensity +=
        (this.options.ambientLightIntensityDay * dayProgress -
          this.currentAmbientIntensity) *
        this.options.transitionSpeed
      this.ambientLight.intensity = THREE.MathUtils.clamp(
        this.currentAmbientIntensity,
        this.options.ambientLightIntensityNight,
        this.options.ambientLightIntensityDay
      )

      // Smoothly interpolate directional light intensity
      this.currentDirLightIntensity +=
        (this.options.directionalLightIntensityDay -
          this.currentDirLightIntensity) *
        this.options.transitionSpeed
      this.dirLight.intensity = THREE.MathUtils.clamp(
        this.currentDirLightIntensity,
        this.options.directionalLightIntensityNight,
        this.options.directionalLightIntensityDay
      )
    } else {
      // Nighttime
      elevation = 0 // Sun below the horizon
      azimuth = 180 // Adjust for moon or other celestial bodies if desired

      // Smoothly interpolate ambient light intensity
      this.currentAmbientIntensity +=
        (this.options.ambientLightIntensityNight -
          this.currentAmbientIntensity) *
        this.options.transitionSpeed
      this.ambientLight.intensity = THREE.MathUtils.clamp(
        this.currentAmbientIntensity,
        this.options.ambientLightIntensityNight,
        this.options.ambientLightIntensityDay
      )

      // Smoothly interpolate directional light intensity
      this.currentDirLightIntensity +=
        (this.options.directionalLightIntensityNight -
          this.currentDirLightIntensity) *
        this.options.transitionSpeed
      this.dirLight.intensity = THREE.MathUtils.clamp(
        this.currentDirLightIntensity,
        this.options.directionalLightIntensityNight,
        this.options.directionalLightIntensityDay
      )
    }

    // Convert spherical coordinates to Cartesian coordinates
    const phi = THREE.MathUtils.degToRad(90 - elevation)
    const theta = THREE.MathUtils.degToRad(azimuth)

    this.sun.setFromSphericalCoords(1, phi, theta)

    // Update Sky's sun position
    this.skyUniforms['sunPosition'].value.copy(this.sun)

    // Update Directional Light position based on sun
    const distance = 200 // Adjust as needed
    this.dirLight.position.set(
      this.sun.x * distance,
      this.sun.y * distance,
      this.sun.z * distance
    )
    this.dirLight.target.position.copy(this.options.directionalLightTarget)
    this.dirLight.target.updateMatrixWorld()
  }

  update() {
    // Update sun position periodically
    this.updateSunPosition()
  }
}

// ------------------------------
// Terrain Class
// ------------------------------
class Terrain {
  constructor(scene, options = {}, config = {}) {
    this.scene = scene
    this.config = config
    this.options = {
      latitude: config.originLatitude || 0,
      longitude: config.originLongitude || 0
    }

    // Initialize terrain properties
    this.terrainSize = this.config.size || 200
    this.terrainSegments = this.config.segments || 200
    this.scaleMultiplier = this.config.scaleMultiplier || 1
    this.gridSizeMeters = this.config.gridSizeMeters || 500
    this.gridResolution = this.config.gridResolution || 100
    this.elevationAPI =
      this.config.elevationAPI || 'https://epqs.nationalmap.gov/v1/json'

    // Initialize terrain data
    this.elevationData = []
    this.terrainInitialized = false
    this.originLatitude = this.options.latitude
    this.originLongitude = this.options.longitude
    this.terrainPointCloud = null
    this.terrainLineSegments = null
    this.terrainMesh = null
    this.terrainMeshWire = null

    // Initialize storage
    this.LS_TERRAIN_POINTS_KEY = CONFIG.localStorageKeys.terrainPoints
    this.totalPoints = this.gridResolution * this.gridResolution
    this.nextPointIndex = 0
    this.POINTS_BATCH_SIZE = 100

    // Generate grid points
    this.gridPoints = this.generateGrid(
      { latitude: this.originLatitude, longitude: this.originLongitude },
      this.gridSizeMeters,
      this.gridResolution
    )

    // Load saved points from localStorage
    this.savedPoints = this.loadPointsFromLocalStorage()
    if (this.savedPoints.length > 0) {
      console.log(`Loaded ${this.savedPoints.length} points from localStorage.`)
    }

    // Initialize terrain point cloud
    this.initializeTerrainPointCloud()

    // Start fetching elevation data if needed
    this.fetchAndRenderTerrain()
  }

  /**
   * Generates a grid of geographic points around a center location.
   * Ensures exactly gridResolution^2 points are generated.
   * @param {Object} center - Object with latitude and longitude.
   * @param {number} gridSizeMeters - Size of the grid in meters.
   * @param {number} gridResolution - Number of points per axis.
   * @returns {Array} Array of point objects with latitude and longitude.
   */
  generateGrid(
    center,
    gridSizeMeters,
    gridResolution,
    startIndex = 0,
    count = null
  ) {
    const points = []
    const stepMeters = (2 * gridSizeMeters) / (gridResolution - 1)

    const deltaLat = stepMeters / 111000
    const deltaLon =
      stepMeters /
      (111000 * Math.cos(THREE.MathUtils.degToRad(center.latitude)))

    const endIndex = count
      ? Math.min(startIndex + count, gridResolution * gridResolution)
      : gridResolution * gridResolution

    for (let i = startIndex; i < endIndex; i++) {
      const row = Math.floor(i / gridResolution)
      const col = i % gridResolution

      const latOffset = (row - (gridResolution - 1) / 2) * deltaLat
      const lonOffset = (col - (gridResolution - 1) / 2) * deltaLon

      points.push({
        latitude: center.latitude + latOffset,
        longitude: center.longitude + lonOffset
      })
    }

    return points
  }

  /**
   * Saves a batch of points to localStorage.
   * Ensures that the total saved points do not exceed totalPoints.
   * @param {Array} pointsBatch - Array of point objects to save.
   */
  savePointsToLocalStorage(pointsBatch) {
    let savedPoints = Storage.load(this.LS_TERRAIN_POINTS_KEY) || []

    // Calculate available space
    const availableSpace = this.totalPoints - savedPoints.length
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

    Storage.save(this.LS_TERRAIN_POINTS_KEY, savedPoints)
    console.log(`Saved ${pointsToSave.length} points to localStorage.`)
  }

  /**
   * Loads saved points from localStorage.
   * Ensures that no more than totalPoints are loaded.
   * @returns {Array} Array of saved point objects.
   */
  loadPointsFromLocalStorage() {
    let savedPoints = Storage.load(this.LS_TERRAIN_POINTS_KEY) || []

    if (savedPoints.length > this.totalPoints) {
      console.warn(
        `LocalStorage has ${savedPoints.length} points, which exceeds the expected ${this.totalPoints}. Truncating excess points.`
      )
      savedPoints = savedPoints.slice(0, this.totalPoints)
      Storage.save(this.LS_TERRAIN_POINTS_KEY, savedPoints)
    }

    return savedPoints
  }

  /**
   * Fetches elevation data for the terrain grid and renders it.
   */
  async fetchAndRenderTerrain() {
    const savedPointsCount = this.savedPoints.length

    if (savedPointsCount >= this.totalPoints) {
      console.log('All terrain points loaded from localStorage.')
      this.populateTerrainFromSavedPoints(this.savedPoints)
      this.createTerrainMesh(this.savedPoints)
      return
    }

    const remainingPointsCount = this.totalPoints - savedPointsCount
    console.log(`Fetching elevation data for ${remainingPointsCount} points.`)
    const remainingPoints = this.generateGrid(
      { latitude: this.originLatitude, longitude: this.originLongitude },
      this.gridSizeMeters,
      this.gridResolution,
      savedPointsCount,
      remainingPointsCount
    )

    if (remainingPoints.length > 0) {
      await this.fetchElevationGrid(remainingPoints, 'Meters', 10, 3)
      this.savePointsToLocalStorage(this.elevationData)
      this.populateTerrainFromSavedPoints(this.elevationData)
      this.elevationData = [] // Clear buffer
      this.createTerrainMesh(this.savedPoints.concat(this.elevationData))
    }
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
  async fetchElevationGrid(
    points,
    units = 'Meters',
    concurrency = 10,
    retries = 3
  ) {
    let index = 0

    const fetchWithRetry = async (longitude, latitude, attempt = 1) => {
      const elevation = await this.fetchElevation(longitude, latitude, units)
      if ((elevation === null || isNaN(elevation)) && attempt <= retries) {
        const delay = Math.pow(2, attempt) * 100 // Exponential backoff
        console.warn(
          `Retrying elevation fetch for (${latitude.toFixed(
            5
          )}, ${longitude.toFixed(5)}) - Attempt ${attempt + 1
          } after ${delay}ms`
        )
        await new Promise(resolve => setTimeout(resolve, delay))
        return await fetchWithRetry(longitude, latitude, attempt + 1)
      }
      return elevation
    }

    const worker = async () => {
      while (true) {
        let currentIndex
        if (index >= points.length) {
          break
        }
        currentIndex = index++
        const point = points[currentIndex]
        const elevation = await fetchWithRetry(
          point.longitude,
          point.latitude,
          1
        )
        if (elevation !== null) {
          const elevationPoint = {
            latitude: point.latitude,
            longitude: point.longitude,
            elevation: elevation
          }
          this.elevationData.push(elevationPoint)
          console.log(
            `Lat: ${elevationPoint.latitude.toFixed(
              5
            )}, Lon: ${elevationPoint.longitude.toFixed(5)}, Elevation: ${elevationPoint.elevation
            } meters`
          )

          const progress = `Rendered ${this.nextPointIndex} / ${this.totalPoints} points.`
          UI.updateField('progress', progress)
          requestAnimationFrame(() => this.renderTerrainPoints())
        } else {
          console.log(
            `Lat: ${point.latitude.toFixed(5)}, Lon: ${point.longitude.toFixed(
              5
            )}, Elevation: Fetch Failed`
          )
        }
      }
    }

    const workersArray = []
    for (let i = 0; i < concurrency; i++) {
      workersArray.push(worker())
    }

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
  async fetchElevation(longitude, latitude, units = 'Meters') {
    const endpoint = this.elevationAPI
    const url = `${endpoint}?x=${longitude}&y=${latitude}&units=${units}&output=json`

    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Elevation API error: ${response.statusText}`)
      }

      // Log the raw response for debugging
      const text = await response.text()
      console.log(
        `Elevation API response for (${latitude}, ${longitude}):`,
        text
      )

      const data = JSON.parse(text)
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

  /**
   * Initializes the Three.js terrain point cloud.
   */
  initializeTerrainPointCloud() {
    const positions = new Float32Array(this.totalPoints * 3)
    const colors = new Float32Array(this.totalPoints * 3)

    this.terrainGeometry = new THREE.BufferGeometry()
    this.terrainGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    )
    this.terrainGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(colors, 3)
    )

    this.terrainMaterial = new THREE.PointsMaterial({
      size: 0.1,
      vertexColors: true,
      transparent: true,
      opacity: 0.5
    })

    this.terrainPointCloud = new THREE.Points(
      this.terrainGeometry,
      this.terrainMaterial
    )
    this.scene.add(this.terrainPointCloud)
  }

  /**
   * Populates the terrain point cloud from saved points.
   * Ensures that only up to totalPoints are processed.
   * @param {Array} savedPoints - Array of saved point objects.
   */
  populateTerrainFromSavedPoints(savedPoints) {
    const positions = this.terrainPointCloud.geometry.attributes.position.array
    const colors = this.terrainPointCloud.geometry.attributes.color.array

    const pointsToPopulate = savedPoints.slice(0, this.totalPoints) // Ensure no excess points

    pointsToPopulate.forEach((point, index) => {
      const baseIndex = index * 3
      positions[baseIndex] = Utils.mapLongitudeToX(
        point.longitude,
        this.originLongitude,
        this.scaleMultiplier
      )
      positions[baseIndex + 1] = (point.elevation - 0) * this.scaleMultiplier
      positions[baseIndex + 2] = Utils.mapLatitudeToZ(
        point.latitude,
        this.originLatitude,
        this.scaleMultiplier
      )

      const normalizedElevation =
        Math.min(Math.max(point.elevation - 0, 0), 80) / 80
      const color = new THREE.Color().lerpColors(
        new THREE.Color(0x0000ff), // Blue for low elevation
        new THREE.Color(0xff0000), // Red for high elevation
        normalizedElevation
      )

      colors[baseIndex] = color.r
      colors[baseIndex + 1] = color.g
      colors[baseIndex + 2] = color.b
    })

    this.terrainPointCloud.geometry.attributes.position.needsUpdate = true
    this.terrainPointCloud.geometry.attributes.color.needsUpdate = true

    console.log(
      `Populated terrain with ${pointsToPopulate.length} saved points.`
    )
  }

  /**
   * Renders new terrain points into the scene.
   * Ensures that no more than totalPoints are rendered.
   */
  renderTerrainPoints() {
    if (!this.terrainPointCloud || this.elevationData.length === 0) return

    const positions = this.terrainPointCloud.geometry.attributes.position.array
    const colors = this.terrainPointCloud.geometry.attributes.color.array

    const pointsToAdd = Math.min(
      this.POINTS_BATCH_SIZE,
      this.elevationData.length,
      this.totalPoints - this.nextPointIndex
    )

    if (pointsToAdd <= 0) {
      // Once all points are rendered, draw lines and create mesh
      const allSavedPoints = Storage.load(this.LS_TERRAIN_POINTS_KEY) || []
      this.createTerrainMesh(allSavedPoints) // Synchronous line drawing
      return
    }

    const pointsBatch = []
    for (let i = 0; i < pointsToAdd; i++) {
      const point = this.elevationData.shift()
      if (!point) continue

      const baseIndex = this.nextPointIndex * 3

      positions[baseIndex] = Utils.mapLongitudeToX(
        point.longitude,
        this.originLongitude,
        this.scaleMultiplier
      )
      positions[baseIndex + 1] = (point.elevation - 0) * this.scaleMultiplier
      positions[baseIndex + 2] = Utils.mapLatitudeToZ(
        point.latitude,
        this.originLatitude,
        this.scaleMultiplier
      )

      const normalizedElevation =
        Math.min(Math.max(point.elevation - 0, 0), 80) / 80
      const color = new THREE.Color().lerpColors(
        new THREE.Color(0x0000ff), // Blue for low elevation
        new THREE.Color(0xff0000), // Red for high elevation
        normalizedElevation
      )

      colors[baseIndex] = color.r
      colors[baseIndex + 1] = color.g
      colors[baseIndex + 2] = color.b

      pointsBatch.push(point)
      this.nextPointIndex++

      // Prevent exceeding totalPoints
      if (this.nextPointIndex >= this.totalPoints) {
        break
      }
    }

    this.terrainPointCloud.geometry.attributes.position.needsUpdate = true
    this.terrainPointCloud.geometry.attributes.color.needsUpdate = true

    this.savePointsToLocalStorage(pointsBatch)

    console.log(`Rendered ${this.nextPointIndex} / ${this.totalPoints} points.`)

    if (this.nextPointIndex >= this.totalPoints) {
      // All points rendered, draw lines and create mesh
      const allSavedPoints = Storage.load(this.LS_TERRAIN_POINTS_KEY) || []
      this.createTerrainMesh(allSavedPoints) // Synchronous line drawing
    } else {
      // Continue rendering in the next frame
      requestAnimationFrame(() => this.renderTerrainPoints())
    }
  }

  /**
   * Draws terrain lines asynchronously to prevent blocking the main thread.
   * @param {Array} savedPoints - Array of saved point objects.
   */
  async drawTerrainLinesAsync(savedPoints) {
    if (!this.lineDrawingGenerator) {
      this.lineDrawingGenerator = this.terrainLineDrawingGenerator(savedPoints)
    }

    const result = this.lineDrawingGenerator.next()
    if (result.done) {
      this.lineDrawingGenerator = null // Reset generator when done
      console.log('Asynchronous terrain lines drawing completed.')
    } else {
      // Continue drawing in the next frame
      requestAnimationFrame(() => this.drawTerrainLinesAsync(savedPoints))
    }
  }

  /**
   * Generator function for drawing terrain lines.
   * Processes the grid in chunks to avoid blocking.
   * @param {Array} savedPoints - Array of saved point objects.
   */
  *terrainLineDrawingGenerator(savedPoints) {
    const linePositions = []
    const metersPerDegLat = 111320 * this.scaleMultiplier
    const metersPerDegLon = 110540 * this.scaleMultiplier

    const gridSize = this.gridResolution // Number of rows and columns
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

        const currentX = Utils.mapLongitudeToX(
          currentPoint.longitude,
          this.originLongitude,
          this.scaleMultiplier
        )
        const currentZ = Utils.mapLatitudeToZ(
          currentPoint.latitude,
          this.originLatitude,
          this.scaleMultiplier
        )
        const currentY = (currentPoint.elevation - 0) * this.scaleMultiplier

        // Right neighbor (only if not on the last column)
        if (j < gridSize - 1) {
          const rightNeighborIndex = currentIndex + 1
          const rightNeighbor = savedPoints[rightNeighborIndex]
          if (rightNeighbor) {
            const rightX = Utils.mapLongitudeToX(
              rightNeighbor.longitude,
              this.originLongitude,
              this.scaleMultiplier
            )
            const rightZ = Utils.mapLatitudeToZ(
              rightNeighbor.latitude,
              this.originLatitude,
              this.scaleMultiplier
            )
            const rightY = (rightNeighbor.elevation - 0) * this.scaleMultiplier

            const distanceSq = calculateDistanceSq(
              currentX,
              currentZ,
              rightX,
              rightZ
            )
            if (distanceSq <= maxLineDistanceSq) {
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
            const bottomX = Utils.mapLongitudeToX(
              bottomNeighbor.longitude,
              this.originLongitude,
              this.scaleMultiplier
            )
            const bottomZ = Utils.mapLatitudeToZ(
              bottomNeighbor.latitude,
              this.originLatitude,
              this.scaleMultiplier
            )
            const bottomY =
              (bottomNeighbor.elevation - 0) * this.scaleMultiplier

            const distanceSq = calculateDistanceSq(
              currentX,
              currentZ,
              bottomX,
              bottomZ
            )
            if (distanceSq <= maxLineDistanceSq) {
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
    this.terrainLineSegments = new THREE.LineSegments(
      lineGeometry,
      lineMaterial
    )
    //this.scene.add(this.terrainLineSegments);

    yield // Final yield to indicate completion
  }

  /**
   * Creates the terrain mesh from saved points.
   * Ensures that the number of points matches the grid's expectation.
   * @param {Array} savedPoints - Array of saved point objects.
   */
  createTerrainMesh(savedPoints) {
    // Validate the length of savedPoints
    if (savedPoints.length !== this.totalPoints) {
      console.error(
        `Expected ${this.totalPoints} points, but got ${savedPoints.length}. Aborting mesh creation.`
      )
      return
    }

    // Define meters per degree based on a fixed latitude for simplicity
    const metersPerDegLat = 111320 * this.scaleMultiplier
    const metersPerDegLon = 110540 * this.scaleMultiplier // Adjust based on average latitude if necessary

    // Define origin for global positioning based on actual location
    const origin = {
      longitude: this.originLongitude,
      latitude: this.originLatitude
    }

    // Step 1: Determine global min and max for X (longitude) and Z (latitude)
    const xCoords = savedPoints.map(point =>
      Utils.mapLongitudeToX(
        point.longitude,
        origin.longitude,
        this.scaleMultiplier
      )
    )
    const zCoords = savedPoints.map(point =>
      Utils.mapLatitudeToZ(
        point.latitude,
        origin.latitude,
        this.scaleMultiplier
      )
    )

    const minX = Math.min(...xCoords)
    const maxX = Math.max(...xCoords)
    const minZ = Math.min(...zCoords)
    const maxZ = Math.max(...zCoords)

    // Calculate expected grid spacing
    const deltaX = (maxX - minX) / (this.gridResolution - 1)
    const deltaZ = (maxZ - minZ) / (this.gridResolution - 1)

    // Initialize a 2D array to hold sorted points
    const sortedGrid = Array.from({ length: this.gridResolution }, () =>
      Array(this.gridResolution).fill(null)
    )

    // Step 2: Assign each saved point to the appropriate grid cell
    savedPoints.forEach(point => {
      const x = Utils.mapLongitudeToX(
        point.longitude,
        origin.longitude,
        this.scaleMultiplier
      )
      const z = Utils.mapLatitudeToZ(
        point.latitude,
        origin.latitude,
        this.scaleMultiplier
      )

      let col = Math.round((x - minX) / deltaX)
      let row = Math.round((z - minZ) / deltaZ)

      col = Math.max(0, Math.min(this.gridResolution - 1, col))
      row = Math.max(0, Math.min(this.gridResolution - 1, row))

      if (sortedGrid[row][col] === null) {
        sortedGrid[row][col] = point
      } else {
        // Handle duplicate assignments by choosing the closest point
        const existingPoint = sortedGrid[row][col]
        const existingX = Utils.mapLongitudeToX(
          existingPoint.longitude,
          origin.longitude,
          this.scaleMultiplier
        )
        const existingZ = Utils.mapLatitudeToZ(
          existingPoint.latitude,
          origin.latitude,
          this.scaleMultiplier
        )
        const existingDistanceSq = Utils.calculateDistanceSq(
          existingX,
          existingZ,
          x,
          z
        )

        const newDistanceSq = Utils.calculateDistanceSq(
          existingX,
          existingZ,
          x,
          z
        )

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
    for (let row = 0; row < this.gridResolution; row++) {
      for (let col = 0; col < this.gridResolution; col++) {
        if (sortedGrid[row][col] === null) {
          console.warn(
            `Missing point at row ${row}, col ${col}. Generating a new point.`
          )

          // Generate a new point by interpolating from existing neighbors
          const generatedPoint = this.generateMissingPoint(row, col, sortedGrid)

          if (generatedPoint) {
            sortedGrid[row][col] = generatedPoint
            console.log(
              `Generated point at row ${row}, col ${col}: Lat=${generatedPoint.latitude.toFixed(
                5
              )}, Lon=${generatedPoint.longitude.toFixed(5)}, Elevation=${generatedPoint.elevation
              }`
            )
          } else {
            // If unable to generate, assign a default elevation
            const defaultElevation = 0
            const generatedLongitude =
              origin.longitude +
              ((col - (this.gridResolution - 1) / 2) *
                (deltaX / this.scaleMultiplier)) /
              metersPerDegLon
            const generatedLatitude =
              origin.latitude +
              ((row - (this.gridResolution - 1) / 2) *
                (deltaZ / this.scaleMultiplier)) /
              metersPerDegLat

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
    const vertices = new Float32Array(this.totalPoints * 3) // x, y, z for each point
    const colors = new Float32Array(this.totalPoints * 3) // r, g, b for each point

    for (let row = 0; row < this.gridResolution; row++) {
      for (let col = 0; col < this.gridResolution; col++) {
        const index = row * this.gridResolution + col
        const point = sortedGrid[row][col]
        const vertexIndex = index * 3

        const x = Utils.mapLongitudeToX(
          point.longitude,
          origin.longitude,
          this.scaleMultiplier
        )
        const y = (point.elevation - 0) * this.scaleMultiplier
        const z = Utils.mapLatitudeToZ(
          point.latitude,
          origin.latitude,
          this.scaleMultiplier
        )

        vertices[vertexIndex] = x
        vertices[vertexIndex + 1] = y
        vertices[vertexIndex + 2] = z

        // Calculate color based on elevation
        const normalizedElevation =
          Math.min(Math.max(point.elevation - 0, 0), 40) / 40
        const color = new THREE.Color().lerpColors(
          new THREE.Color(0x000000), // Blue for low elevation
          new THREE.Color(0xffffff), // White for high elevation
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

    for (let row = 0; row < this.gridResolution - 1; row++) {
      for (let col = 0; col < this.gridResolution - 1; col++) {
        const a = row * this.gridResolution + col
        const b = a + 1
        const c = a + this.gridResolution
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
        const distanceACSq = Utils.calculateDistanceSq(ax, az, cx, cz)
        const distanceCBSq = Utils.calculateDistanceSq(cx, cz, bx, bz)
        const distanceABSq = Utils.calculateDistanceSq(ax, az, bx, bz)

        const distanceBCSq = Utils.calculateDistanceSq(bx, bz, cx, cz)
        const distanceCDSq = Utils.calculateDistanceSq(cx, cz, dxPos, dz)
        const distanceBDSq = Utils.calculateDistanceSq(bx, bz, dxPos, dz)

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
      opacity: 0.5, // Set opacity level
      metalness: 0.7, // Slight reflectivity (range: 0.0 - 1.0)
      roughness: 0.2 // Moderate roughness for shading (range: 0.0 - 1.0)
    })

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, // Enable vertex colors
      wireframe: false, // Solid mesh
      transparent: true, // Enable transparency
      side: THREE.DoubleSide,
      opacity: 1, // Full opacity
      metalness: 0.2, // Higher reflectivity
      roughness: 0.7 // Moderate roughness
    })

    // Step 8: Create and Add the Terrain Mesh to the Scene
    this.terrainMesh = new THREE.Mesh(geometry, material)
    this.terrainMesh.receiveShadow = true
    this.scene.add(this.terrainMesh)

    // Step 9: Create and Add the Terrain Mesh Wireframe to the Scene
    this.terrainMeshWire = new THREE.Mesh(geometry, materialWire)
    this.scene.add(this.terrainMeshWire)

    console.log('Terrain mesh created and added to the scene.')
  }

  /**
   * Generates a missing point by interpolating elevation from neighboring points.
   * @param {number} row - Row index in the grid.
   * @param {number} col - Column index in the grid.
   * @param {Array} sortedGrid - 2D array of sorted points.
   * @returns {Object|null} Generated point object or null if unable to generate.
   */
  generateMissingPoint(row, col, sortedGrid) {
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
      [row + 1, col + 1] // Bottom-Right
    ]

    neighborOffsets.forEach(offset => {
      const [nRow, nCol] = offset
      if (
        nRow >= 0 &&
        nRow < this.gridResolution &&
        nCol >= 0 &&
        nCol < this.gridResolution
      ) {
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
    const stepMeters = (2 * this.gridSizeMeters) / (this.gridResolution - 1)
    const deltaLat = stepMeters / 111000
    const deltaLon =
      stepMeters /
      (111000 * Math.cos(THREE.MathUtils.degToRad(this.options.latitude)))

    const generatedLongitude =
      this.originLongitude + (col - (this.gridResolution - 1) / 2) * deltaLon
    const generatedLatitude =
      this.originLatitude + (row - (this.gridResolution - 1) / 2) * deltaLat

    return {
      longitude: generatedLongitude,
      latitude: generatedLatitude,
      elevation: averageElevation
    }
  }

  /**
   * Finds the closest grid point to a given (x, z) coordinate.
   * @param {number} x - X coordinate in meters.
   * @param {number} z - Z coordinate in meters.
   * @returns {Object|null} Closest point object or null if not found.
   */
  findClosestGridPoint(x, z) {
    let closestPoint = null
    let minDistanceSq = Infinity

    this.savedPoints.forEach(point => {
      const px = Utils.mapLongitudeToX(
        point.longitude,
        this.originLongitude,
        this.scaleMultiplier
      )
      const pz = Utils.mapLatitudeToZ(
        point.latitude,
        this.originLatitude,
        this.scaleMultiplier
      )
      const distanceSq = Utils.calculateDistanceSq(x, z, px, pz)
      if (distanceSq < minDistanceSq) {
        minDistanceSq = distanceSq
        closestPoint = point
      }
    })

    return closestPoint
  }

  /**
   * Gets the terrain height at a given (x, z) coordinate.
   * @param {number} x - X coordinate in meters.
   * @param {number} z - Z coordinate in meters.
   * @returns {number} Elevation in meters.
   */
  getTerrainHeightAtPoint(x, z) {
    const closestPoint = this.findClosestGridPoint(x, z)

    if (!closestPoint) {
      console.warn(
        `No terrain data found for coordinates (${x}, ${z}). Returning default elevation 0.`
      )
      return 0
    }

    const elevationRaw = closestPoint.elevation
    const elevation = parseFloat(elevationRaw)

    // Log the raw and converted elevation values for debugging
    console.log(`Raw Elevation: ${elevationRaw} (Type: ${typeof elevationRaw})`)
    console.log(`Converted Elevation: ${elevation} (Type: ${typeof elevation})`)

    if (isNaN(elevation)) {
      console.error(
        `Invalid elevation value: "${elevationRaw}". Returning default elevation 0.`
      )
      return 0
    }

    return elevation
  }

  getTerrainHeightAt(x, z) {
    if (!this.terrainMesh) return 0
    if (this.terrainMesh === NaN) return 0

    // Create a raycaster pointing downwards from a high y value
    const rayOrigin = new THREE.Vector3(x, 1000, z)
    const rayDirection = new THREE.Vector3(0, -1, 0)
    const raycaster = new THREE.Raycaster(rayOrigin, rayDirection)

    const intersects = raycaster.intersectObject(this.terrainMesh)
    if (intersects.length > 0) {
      return intersects[0].point.y
    }

    // Default to 0 if no intersection
    return 0
  }
}

// ------------------------------
// VRControllers Class
// ------------------------------
class VRControllers {
  constructor(
    renderer,
    scene,
    handleTeleportCallback,
    teleportableObjects = []
  ) {
    this.renderer = renderer
    this.scene = scene
    this.handleTeleportCallback = handleTeleportCallback

    // The objects (meshes) we raycast against for teleporting:
    this.teleportableObjects = teleportableObjects

    this.controllers = []
    this.controllerGrips = []
    this.raycaster = new THREE.Raycaster()
    this.tempMatrix = new THREE.Matrix4()
    this.INTERSECTION = null

    // Optional "marker" to show where you'd teleport:
    this.marker = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xbcbcbc })
    )
    this.marker.visible = false
    this.scene.add(this.marker)

    this.baseReferenceSpace = null
    this.renderer.xr.addEventListener('sessionstart', () => {
      this.baseReferenceSpace = this.renderer.xr.getReferenceSpace()
    })

    this.controllerData = []
    this.initControllers()
  }

  initControllers() {
    const modelFactory = new XRControllerModelFactory()

    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i)
      controller.addEventListener('selectstart', evt =>
        this.onSelectStart(evt, i)
      )
      controller.addEventListener('selectend', evt => this.onSelectEnd(evt, i))
      this.scene.add(controller)
      this.controllers.push(controller)

      // A separate "grip" with the device model
      const controllerGrip = this.renderer.xr.getControllerGrip(i)
      controllerGrip.add(modelFactory.createControllerModel(controllerGrip))
      this.scene.add(controllerGrip)
      this.controllerGrips.push(controllerGrip)

      // Data about each controller
      this.controllerData[i] = {
        isSelecting: false,
        xrController: controller
      }
    }
  }

  onSelectStart(event, index) {
    this.controllerData[index].isSelecting = true
  }

  onSelectEnd(event, index) {
    this.controllerData[index].isSelecting = false
    // If we have an intersection and a valid reference space, TELEPORT
    if (this.INTERSECTION && this.baseReferenceSpace) {
      const offsetPos = {
        x: -this.INTERSECTION.x,
        y: -this.INTERSECTION.y,
        z: -this.INTERSECTION.z,
        w: 1
      }
      const offsetRot = new THREE.Quaternion()
      const transform = new XRRigidTransform(offsetPos, offsetRot)
      const teleportSpaceOffset =
        this.baseReferenceSpace.getOffsetReferenceSpace(transform)
      this.renderer.xr.setReferenceSpace(teleportSpaceOffset)

      // If you have extra teleport logic:
      if (typeof this.handleTeleportCallback === 'function') {
        this.handleTeleportCallback(this.INTERSECTION)
      }
    }
  }

  /**
   * Call this each frame from your main render loop to perform raycast checks.
   */
  update() {
    this.INTERSECTION = null
    let foundIntersection = false

    for (let i = 0; i < this.controllerData.length; i++) {
      const data = this.controllerData[i]
      if (!data || !data.xrController) continue

      if (data.isSelecting) {
        this.tempMatrix
          .identity()
          .extractRotation(data.xrController.matrixWorld)

        this.raycaster.ray.origin.setFromMatrixPosition(
          data.xrController.matrixWorld
        )
        this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix)

        // Raycast against the array of "teleportable" objects
        const intersects = this.raycaster.intersectObjects(
          this.teleportableObjects,
          false
        )
        if (intersects.length > 0) {
          this.INTERSECTION = intersects[0].point
          foundIntersection = true
          break // if only want first intersection
        }
      }
    }

    // Show or hide the marker
    if (this.INTERSECTION) {
      this.marker.position.copy(this.INTERSECTION)
      this.marker.visible = true
    } else {
      this.marker.visible = false
    }
  }

  /**
   * Optionally allow you to set the teleportable objects later if you want.
   */
  setTeleportableObjects(meshes) {
    this.teleportableObjects = meshes || []
  }
}

// ------------------------------
// Multiplayer Class
// ------------------------------
class Multiplayer {
  constructor(socket, scene, terrain) {
    this.initializePlayerID()
    this.socket = socket
    this.scene = scene
    this.terrain = terrain
    this.players = {}
    this.loadingPlayers = new Set()
    this.remoteAudioStreams = {} // To manage audio streams
    this.initSocketEvents()
  }

  /**
   * Initializes the playerID by retrieving it from localStorage.
   * If not found, it remains null and will be set by the server upon 'init' event.
   */
  initializePlayerID() {
    const storedPlayerID = Storage.load(CONFIG.localStorageKeys.playerID)
    if (storedPlayerID) {
      this.myId = storedPlayerID
      console.warn(`Retrieved playerID from localStorage: ${this.myId}`)
      // Optionally, emit the playerID to the server if the server supports custom player IDs
      console.warn(`Emitting playerID to server: ${this.myId}`)
    } else {
      console.warn('No playerID found in localStorage. Assigning.')
      const generatedID = `user-${Date.now()}-${Math.floor(
        Math.random() * 100000
      )}`
      console.warn(generatedID)
      Storage.save(CONFIG.localStorageKeys.playerID, generatedID)
      this.myId = generatedID
      console.warn(`Generated new playerID: ${this.myId}`)
    }
  }

  /**
   * Initializes socket event listeners.
   */
  initSocketEvents() {
    this.socket.on('init', data => {
      console.log('[Socket] init => received init data:', data)

      // Store the ID the server gave us.
      this.myId = data.id

      // Update players with the full dictionary from the server
      this.updatePlayers(data.players)
    })

    this.socket.on('state_update_all', data => {
      this.updatePlayers(data)
      // Optionally, store last state if needed
    })

    this.socket.on('new_player', data => {
      console.log(`[Socket] new_player => Data:`, data)

      // Skip if the new player is us
      if (data.id === this.myId) {
        return
      }

      console.log(
        `[Socket] new_player => Creating or updating remote ID: ${data.id}`
      )
      this.addOrUpdatePlayer(data.id, data)
    })

    this.socket.on('state_update', data => {
      const incomingString = JSON.stringify(data)
      const lastString = this.lastStateData
        ? JSON.stringify(this.lastStateData)
        : null

      // Only log if changed
      if (incomingString !== lastString) {
        //console.log('[Socket] state_update => changed data from server:', data);
        this.lastStateData = data
      }
    })

    this.socket.on('player_disconnected', id => {
      this.removeRemotePlayer(id)
    })

    // Audio events
    this.socket.on('start_audio', data => {
      const { id } = data
      this.addRemoteAudioStream(id)
    })

    this.socket.on('stop_audio', data => {
      const { id } = data
      this.removeRemoteAudioStream(id)
    })

    this.socket.on('audio_stream', data => {
      const { id, audio } = data
      this.receiveAudioStream(id, audio)
    })

    // Position event with encryption
    this.socket.on('position', async data => {
      const { id, encryptedPosition } = data
      console.log(
        `[Socket] position => Received encrypted position from ID: ${id}`
      )

      // Retrieve the password from localStorage
      const password = Storage.load(CONFIG.localStorageKeys.encryptedPassword)
      if (!password) {
        console.error('Password not found. Cannot decrypt position data.')
        return
      }

      try {
        // Decrypt the received data
        const decryptedData = await Encryption.decryptLatLon(
          encryptedPosition,
          password
        )
        if (decryptedData) {
          const { latitude, longitude } = decryptedData
          console.log(
            `[Socket] position => Decrypted Position from ID: ${id}: Lat=${latitude}, Lon=${longitude}`
          )

          // Map latitude and longitude to your game's coordinate system
          const x = Utils.mapLongitudeToX(
            longitude,
            this.terrain.originLongitude,
            this.terrain.scaleMultiplier
          )
          const z = Utils.mapLatitudeToZ(
            latitude,
            this.terrain.originLatitude,
            this.terrain.scaleMultiplier
          )

          // Update the player's position in your game
          if (this.players[id]) {
            // Assuming players[id].position is a THREE.Vector3
            this.players[id].position.set(
              x,
              this.terrain.getTerrainHeightAt(x, z),
              z
            )
            this.players[id].model.position.lerp(this.players[id].position, 0.1) // Smooth transition
          } else {
            console.warn(
              `[Socket] position => Player with ID: ${id} not found.`
            )
          }
        } else {
          console.warn(
            `[Socket] position => Failed to decrypt position data from ID: ${id}.`
          )
        }
      } catch (error) {
        console.error(
          `[Socket] position => Error decrypting position data from ID: ${id}:`,
          error
        )
      }
    })
  }

  /**
   * Adds or updates a remote player based on incoming data.
   * @param {string} id - The unique identifier for the player.
   * @param {Object} data - The data associated with the player.
   */
  addOrUpdatePlayer(id, data) {
    // Skip if it's the local player's ID
    if (data.id === this.myId) {
      console.warn(`Skipping addOrUpdatePlayer for local ID = ${data.id}`)
      return
    }

    if (!this.players[id] && !this.loadingPlayers.has(id)) {
      this.createRemotePlayer(id, data)
      //console.warn(`Creating new player with ID: ${id}`);
    } else {
      this.updateRemotePlayer(id, data)
      //console.warn(`Updating existing player with ID: ${id}`);
    }
  }

  /**
   * Creates a new remote player.
   * @param {string} id - The unique identifier for the player.
   * @param {Object} data - The data associated with the player.
   */
  createRemotePlayer(id, data) {
    if (this.players[id] || this.loadingPlayers.has(id)) {
      console.warn(
        `Skipping creation for player ${id}. Already exists or is loading.`
      )
      return
    }
    this.loadingPlayers.add(id)

    const loader = new GLTFLoader()
    loader.load(
      CONFIG.modelPath,
      gltf => {
        const remoteModel = gltf.scene

        // Determine terrain height safely
        let terrainHeight = 0 // Default value
        if (
          this.terrain &&
          typeof this.terrain.getTerrainHeightAt === 'function'
        ) {
          terrainHeight = this.terrain.getTerrainHeightAt(data.x, data.z)
        } else {
          console.warn(
            'Multiplayer: Terrain instance or method getTerrainHeightAt is unavailable.'
          )
        }

        // Set the model's position based on data and terrain height
        remoteModel.position.set(data.x, terrainHeight, data.z)
        remoteModel.rotation.y = data.rotation

        // Add to scene
        this.scene.add(remoteModel)

        // Setup animations
        const remoteMixer = new THREE.AnimationMixer(remoteModel)
        const remoteActions = {}
        gltf.animations.forEach(clip => {
          remoteActions[clip.name] = remoteMixer.clipAction(clip)
        })
        if (remoteActions['idle']) {
          remoteActions['idle'].play()
        }

        this.players[id] = {
          model: remoteModel,
          mixer: remoteMixer,
          actions: remoteActions,
          position: new THREE.Vector3(data.x, terrainHeight, data.z), // Updated y with terrainHeight
          rotation: data.rotation,
          currentAction: 'idle',
          initialized: true
        }
        this.loadingPlayers.delete(id)
      },
      undefined,
      err =>
        console.error(`Error loading model for player ${data.localId}:`, err)
    )
  }

  /**
   * Updates an existing remote player.
   * @param {string} id - The unique identifier for the player.
   * @param {Object} data - The data associated with the player.
   */
  updateRemotePlayer(id, data) {
    const player = this.players[id]
    if (!player) return

    // Determine terrain height safely
    let terrainHeight = 0 // Default value
    terrainHeight = this.terrain.getTerrainHeightAt(data.x, data.z)
    //console.warn(`Terrain height for player ${id}: ${terrainHeight}`);
    if (!player.initialized) {
      player.model.position.set(data.x, 0, data.z)
      player.model.rotation.y = data.rotation
      player.position.set(
        data.x,
        this.terrain.getTerrainHeightAt(data.x, data.z),
        data.z
      ) // Ensure player's internal position is also updated
      player.initialized = true
      return
    }

    player.position.set(
      data.x,
      this.terrain.getTerrainHeightAt(data.x, data.z),
      data.z
    )
    //console.warn(`Player ${id} position: ${player.position.x}, ${player.position.y}, ${player.position.z}`);
    player.model.position.lerp(player.position, 0.1)

    const currentAngle = player.model.rotation.y
    const targetAngle = data.rotation
    player.model.rotation.y = Utils.lerpAngle(currentAngle, targetAngle, 0.1)

    if (this.remoteAudioStreams[id]) {
      this.remoteAudioStreams[id].positionalAudio.position.copy(
        player.model.position
      )
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

  /**
   * Removes a remote player from the scene.
   * @param {string} id - The unique identifier for the player.
   */
  removeRemotePlayer(id) {
    if (this.players[id]) {
      this.scene.remove(this.players[id].model)
      delete this.players[id]
    }
    this.removeRemoteAudioStream(id)
  }

  /**
   * Updates all players based on incoming data.
   * @param {Object} playersData - Data for all players.
   */
  updatePlayers(playersData) {
    Object.keys(playersData).forEach(id => {
      if (playersData[id].localId === this.myId) return
      this.addOrUpdatePlayer(id, playersData[id])
    })
    Object.keys(this.players).forEach(id => {
      if (!playersData[id]) {
        this.removeRemotePlayer(id)
      }
    })
  }

  // ------------------------------
  // Audio Streaming
  // ------------------------------
  addRemoteAudioStream(id) {
    if (!this.socket) {
      console.warn('Socket not initialized. Cannot add remote audio stream.')
      return
    }
    const player = this.players[id]
    if (!player) {
      console.warn(`Player with ID ${id} not found.`)
      return
    }
    if (this.remoteAudioStreams && this.remoteAudioStreams[id]) return

    const listener = new THREE.AudioListener()
    this.scene.add(listener)

    const positionalAudio = new THREE.PositionalAudio(listener)
    positionalAudio.setRefDistance(20)
    positionalAudio.setVolume(1.0)
    player.model.add(positionalAudio)
    positionalAudio.play()

    if (!this.remoteAudioStreams) {
      this.remoteAudioStreams = {}
    }
    this.remoteAudioStreams[id] = { positionalAudio }
  }

  removeRemoteAudioStream(id) {
    const remoteAudio = this.remoteAudioStreams
      ? this.remoteAudioStreams[id]
      : null
    if (remoteAudio) {
      remoteAudio.positionalAudio.stop()
      remoteAudio.positionalAudio.disconnect()
      remoteAudio.positionalAudio = null
      delete this.remoteAudioStreams[id]
    }
  }

  receiveAudioStream(id, audioBuffer) {
    if (!this.remoteAudioStreams || !this.remoteAudioStreams[id]) {
      console.warn(
        `Received audio data from ${id} before audio stream started.`
      )
      return
    }

    const remoteAudio = this.remoteAudioStreams[id].positionalAudio
    const audioContext = remoteAudio.context

    const int16 = new Int16Array(audioBuffer)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32767
    }
    const buffer = audioContext.createBuffer(
      1,
      float32.length,
      audioContext.sampleRate
    )
    buffer.copyToChannel(float32, 0, 0)

    const bufferSource = audioContext.createBufferSource()
    bufferSource.buffer = buffer
    bufferSource.connect(remoteAudio.gain)
    bufferSource.start()

    bufferSource.onended = () => {
      bufferSource.disconnect()
    }
  }
}

// ------------------------------
// Movement Class
// ------------------------------
class Movement {
  constructor(app) {
    this.app = app
    this.moveForward = false
    this.moveBackward = false
    this.strafeLeft = false
    this.strafeRight = false
    this.isRunning = false

    this.yaw = 0
    this.pitch = 0
    this.mouseSensitivity = 0.002

    this.pitchMin = -Math.PI / 2 + 0.1
    this.pitchMax = Math.PI / 2 - 0.1

    this.keyStates = {
      w: false,
      a: false,
      s: false,
      d: false,
      Shift: false,
      r: false
    }

    this.initKeyboardEvents()
  }

  initKeyboardEvents() {
    console.log('Initializing keyboard events for movement.')
    document.addEventListener('keydown', this.onKeyDown.bind(this))
    document.addEventListener('keyup', this.onKeyUp.bind(this))
  }

  onKeyDown(e) {
    switch (e.key.toLowerCase()) {
      case 'w':
        this.keyStates.w = true
        break
      case 's':
        this.keyStates.s = true
        break
      case 'a':
        this.keyStates.a = true
        break
      case 'd':
        this.keyStates.d = true
        break
      case 'shift':
        this.keyStates.Shift = true
        break
      case 'r':
        if (!this.keyStates.r) this.app.startBroadcast()
        this.keyStates.r = true
        break
    }
    //console.warn(`Key Down: ${e.key}`);
    this.handleKeyStates()
  }

  onKeyUp(e) {
    switch (e.key.toLowerCase()) {
      case 'w':
        this.keyStates.w = false
        break
      case 's':
        this.keyStates.s = false
        break
      case 'a':
        this.keyStates.a = false
        break
      case 'd':
        this.keyStates.d = false
        break
      case 'shift':
        this.keyStates.Shift = false
        break
      case 'r':
        this.app.stopBroadcast()
        this.keyStates.r = false
        break
    }
    //console.warn(`Key Up: ${e.key}`);
    this.handleKeyStates()
  }

  handleKeyStates() {
    this.moveForward = this.keyStates.w
    this.moveBackward = this.keyStates.s
    this.strafeLeft = this.keyStates.a
    this.strafeRight = this.keyStates.d
    this.isRunning =
      this.keyStates.Shift &&
      (this.moveForward ||
        this.moveBackward ||
        this.strafeLeft ||
        this.strafeRight)

    let action = 'idle'
    if (
      this.moveForward ||
      this.moveBackward ||
      this.strafeLeft ||
      this.strafeRight
    ) {
      action = this.isRunning ? 'run' : 'walk'
    }
    this.app.setLocalAction(action)
    //console.warn(`Action: ${action}`);
  }
  /**
   * Handles character movement based on keyboard inputs with acceleration over time.
   * @param {number} delta - Time delta since last frame.
   */
  moveCharacter(delta) {
    if (!this.app.localModel) return

    // Initialize acceleration properties if not already present
    if (this.accelerationMultiplier === undefined) {
      this.accelerationMultiplier = 1 // Starts at base speed
    }

    // Configuration for acceleration
    const accelerationDuration = CONFIG.motionVars.accelerationDuration || 5 // Duration in seconds
    const maxMultiplier = CONFIG.motionVars.maxSpeedFactor || 100 // Maximum speed multiplier

    // Calculate acceleration and deceleration rates
    const accelerationRate = (maxMultiplier - 1) / accelerationDuration // Multiplier units per second
    const decelerationRate = (maxMultiplier - 1) / accelerationDuration // Assuming same rate for simplicity

    // Determine if the character is running or walking
    const isRunning = this.isRunning // Boolean indicating running state

    // Base speed based on running state
    const baseSpeed = isRunning
      ? CONFIG.motionVars.runSpeed
      : CONFIG.motionVars.walkSpeed

    // Validate baseSpeed and delta
    if (typeof baseSpeed !== 'number' || isNaN(baseSpeed)) {
      console.error(`Invalid base speed value: ${baseSpeed}. Movement aborted.`)
      return
    }

    if (typeof delta !== 'number' || isNaN(delta)) {
      console.error(`Invalid delta value: ${delta}. Movement aborted.`)
      return
    }

    const forwardVec = new THREE.Vector3()
    const rightVec = new THREE.Vector3()

    // Get camera's yaw
    const cameraYaw = new THREE.Euler().setFromQuaternion(
      this.app.camera.quaternion,
      'YXZ'
    ).y

    forwardVec.set(0, 0, -1).applyEuler(new THREE.Euler(0, cameraYaw, 0))
    rightVec.set(1, 0, 0).applyEuler(new THREE.Euler(0, cameraYaw, 0))

    const movement = new THREE.Vector3()

    if (this.moveForward) movement.add(forwardVec)
    if (this.moveBackward) movement.sub(forwardVec)
    if (this.strafeLeft) movement.sub(rightVec)
    if (this.strafeRight) movement.add(rightVec)

    if (movement.length() > 0) {
      // Normalize movement vector
      movement.normalize()

      if (isRunning) {
        // Increment accelerationMultiplier based on accelerationRate and delta
        this.accelerationMultiplier += accelerationRate * delta
        // Clamp to maxMultiplier
        this.accelerationMultiplier = Math.min(
          this.accelerationMultiplier,
          maxMultiplier
        )
      } else {
        // Decrement accelerationMultiplier based on decelerationRate and delta
        this.accelerationMultiplier -= decelerationRate * delta
        // Clamp to a minimum of 1
        this.accelerationMultiplier = Math.max(this.accelerationMultiplier, 1)
      }

      // Calculate current speed
      const currentSpeed = baseSpeed * this.accelerationMultiplier

      // Calculate movement based on currentSpeed
      const movementVector = movement
        .clone()
        .multiplyScalar(currentSpeed * delta)

      // Add movement to the localModel's position
      this.app.localModel.position.add(movementVector)

      // Get terrain height at the new localModel position
      const terrainHeight = this.app.terrain.getTerrainHeightAt(
        this.app.localModel.position.x,
        this.app.localModel.position.z
      ) // Assuming this.app.terrain.findClosestGridPoint is a method that calculates the closest point
      const closestPoint = this.app.terrain.findClosestGridPoint(
        this.app.localModel.position.x,
        this.app.localModel.position.z
      )

      // Log the closest point to the console for debugging
      console.warn(closestPoint)

      // Expose the closest point to the global window object
      window.terrainPointClosest = {
        latitude: closestPoint.latitude,
        longitude: closestPoint.longitude,
        elevation: closestPoint.elevation.toString() // Ensure elevation is a string as per schema
      }

      // Log the global variable to confirm the assignment
      //console.log('Global terrainPointClosest set:', window.terrainPointClosest);

      // Validate and apply terrainHeight to localModel's y position
      if (typeof terrainHeight !== 'number' || isNaN(terrainHeight)) {
        console.error(
          'Terrain height is invalid. Setting localModel y position to default value (0).'
        )
        this.app.localModel.position.y = 0 // Assign a default value
      } else {
        this.app.localModel.position.y = terrainHeight
      }

      // Update camera position to follow the localModel with a fixed offset
      const cameraOffset = new THREE.Vector3(0, 1.7, 0)
      this.app.camera.position.copy(
        this.app.localModel.position.clone().add(cameraOffset)
      )
    } else {
      // No movement detected; reset accelerationMultiplier towards 1
      if (this.accelerationMultiplier > 1) {
        this.accelerationMultiplier -= decelerationRate * delta
        this.accelerationMultiplier = Math.max(this.accelerationMultiplier, 1)
      }
    }

    // Set rotation based on camera yaw
    this.app.localModel.rotation.y = (cameraYaw + Math.PI) % (Math.PI * 2)

    // Save the updated position to local storage
    this.app.savePositionToLocalStorage()

    // Determine the new action based on movement
    const newAction =
      movement.length() > 0 ? (isRunning ? 'run' : 'walk') : 'idle'

    const movementX = this.app.localModel.position.x
    const movementZ = this.app.localModel.position.z

    // Validate movementX and movementZ before emitting
    if (
      typeof movementX !== 'number' ||
      typeof movementZ !== 'number' ||
      isNaN(movementX) ||
      isNaN(movementZ)
    ) {
      console.error(
        'movementX or movementZ is invalid. Skipping emitMovementIfChanged.'
      )
    } else {
      this.app.emitMovementIfChanged({
        x: movementX,
        z: movementZ,
        rotation: this.app.localModel.rotation.y,
        action: newAction
      })
    }

    // Update UI fields with current position and rotation
    UI.updateField('localX', `X ${this.app.localModel.position.x.toFixed(5)}`)
    UI.updateField('localY', `Y ${this.app.localModel.position.y.toFixed(5)}`)
    UI.updateField('localZ', `Z ${this.app.localModel.position.z.toFixed(5)}`)
    UI.updateField(
      'localR',
      this.app.camera.quaternion
        .toArray()
        .map(num => num.toFixed(5))
        .join(', ')
    )

    // Trigger animations if the action has changed
    if (this.app.currentAction !== newAction) {
      this.app.setLocalAction(newAction)
      this.app.currentAction = newAction
    }
  }
}
// ------------------------------
// App Class (Main Application)
// ------------------------------
class App {
  constructor() {
    this.initPaths()
    this.injectFont()
    this.socket = io(CONFIG.socketURL)
    this.simplex = new SimplexNoise()
    this.initSensors()
    this.initScene()
    this.initPostProcessing()
    this.setupVRControllers()
    this.initDayNightCycle()
    this.bindUIEvents()

    // Initialize movement without Terrain (will pass Terrain later)
    this.movement = new Movement(this)

    // Initialize the render loop
    this.animate()

    // Initialize Terrain and dependent classes
    this.initTerrain()
      .then(() => {
        // Initialize Multiplayer after Terrain is ready
        this.initSocketEvents()

        // Load the local player model after Terrain is ready
        this.loadLocalModel()
      })
      .catch(err => {
        console.error('Error initializing Terrain:', err)
        // Even if Terrain fails, proceed to initialize Multiplayer with default Terrain
        this.initSocketEvents()
        this.loadLocalModel()
      })
  }

  /**
   * Initializes paths for models and fonts.
   */
  initPaths() {
    console.log(`Model Path: ${CONFIG.modelPath}`)
    console.log(`Font Path: ${CONFIG.fontPath}`)
  }

  /**
   * Injects custom font into the document.
   */
  injectFont() {
    const styleSheet = new CSSStyleSheet()
    styleSheet.insertRule(`
      @font-face {
        font-family: 'Uno';
        src: url('${CONFIG.fontPath}') format('truetype');
        font-weight: normal;
        font-style: normal;
      }
    `)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet]
  }

  /**
   * Initializes the Three.js scene, camera, and renderer.
   */
  initScene() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x333333)

    this.camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      1,
      1000000
    )
    this.camera.position.set(0, 1.7, 0)

    this.listener = new THREE.AudioListener()
    this.camera.add(this.listener)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.xr.enabled = true
    document.body.appendChild(this.renderer.domElement)

    const sessionInit = { requiredFeatures: ['hand-tracking'] }
    document.body.appendChild(VRButton.createButton(this.renderer, sessionInit))
    this.renderer.xr.addEventListener('sessionstart', () => {
      this.baseReferenceSpace = this.renderer.xr.getReferenceSpace()
    })

    // Teleport marker
    this.markerMesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xbcbcbc })
    )
    this.markerMesh.visible = false
    this.scene.add(this.markerMesh)

    // Pointer Lock Controls (Desktop)
    this.controls = new PointerLockControls(
      this.camera,
      document.getElementById('app')
    )

    const instructions = document.getElementById('app')
    instructions.addEventListener('click', () => {
      this.controls.lock()
    })
    this.scene.add(this.controls.object)

    // Load saved camera position if available
    const savedCam = this.loadPositionFromLocalStorage()
    if (savedCam) {
      console.log('Loaded camera from localStorage:', savedCam)
      this.camera.position.set(savedCam.x, savedCam.y, savedCam.z)
      this.camera.rotation.set(0, savedCam.rotation, 0) // Set only yaw; pitch remains as updated via device orientation
    } else {
      console.log('No saved camera location, using defaults...')
    }

    window.addEventListener('resize', this.onWindowResize.bind(this), false)
  }

  /**
   * Initializes post-processing effects.
   */
  initPostProcessing() {
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))

    if (CONFIG.postProcessing.enableFilmPass) {
      const effectFilm = new FilmPass(0.25)
      this.composer.addPass(effectFilm)
    }

    if (CONFIG.postProcessing.enableRGBShift) {
      const rgbShift = new ShaderPass(RGBShiftShader)
      rgbShift.uniforms['amount'].value = 0.0025
      this.composer.addPass(rgbShift)
    }

    if (CONFIG.postProcessing.enableFXAAPass) {
      const fxaaPass = new ShaderPass(FXAAShader)
      this.composer.addPass(fxaaPass)
    }

    if (CONFIG.postProcessing.enableSSAARenderPass) {
      const ssaaPass = new SSAARenderPass(this.scene, this.camera)
      ssaaPass.sampleLevel = 1
      ssaaPass.unbiased = false
      this.composer.addPass(ssaaPass)
    }

    //this.composer.addPass(new OutputPass());
  }

  /**
   * Sets up VR controllers.
   */
  setupVRControllers() {
    this.vrControllers = new VRControllers(
      this.renderer,
      this.scene,
      this.handleTeleport.bind(this)
    )
  }

  /**
   * Handles teleportation logic.
   * @param {Object} point - The destination point for teleportation.
   */
  handleTeleport(point) {
    if (!this.baseReferenceSpace) return

    const offsetPosition = {
      x: -point.x,
      y: -point.y,
      z: -point.z,
      w: 1
    }
    const offsetRotation = new THREE.Quaternion()
    const transform = new XRRigidTransform(offsetPosition, offsetRotation)
    const teleportSpaceOffset =
      this.baseReferenceSpace.getOffsetReferenceSpace(transform)
    this.renderer.xr.setReferenceSpace(teleportSpaceOffset)

    if (this.localModel) {
      const terrainHeight = this.terrain.getTerrainHeightAt(point.x, point.z)
      this.localModel.position.set(point.x, terrainHeight, point.z)
      this.emitMovementIfChanged({
        x: this.localModel.position.x,
        z: this.localModel.position.z,
        rotation: this.myId // Assuming rotation is handled differently
      })
    }
  }

  /**
   * Initializes sensor event listeners.
   */
  initSensors() {
    const appElement = document.getElementById('request_orient');
    if (!appElement) {
      console.error("Element with id 'request_orient' not found.");
      return;
    }
  
    // =========== DEVICE DETECTION UTILITY ===========
    function isMobileDevice() {
      return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );
    }
  
    // Ensure orientation sensors are only enabled on mobile devices
    if (!isMobileDevice()) {
      console.warn('Orientation sensors are not supported on non-mobile devices.');
      return;
    }
  
    if (typeof Sensors === 'undefined') {
      console.warn('Orientation sensors are not available on this system. Initialization aborted.');
      return;
    }
  
    const initializeSensors = () => {
      console.log('Initializing Sensors.');
      Sensors.initialize();
  
      // Remove the event listeners to prevent repeated initialization
      appElement.removeEventListener('click', handleUserGesture);
      appElement.removeEventListener('touchstart', handleUserGesture);
    };
  
    const handleUserGesture = () => {
      console.log('User gesture detected on #request_orient. Initializing Sensors.');
      initializeSensors();
    };
  
    // Automatically initialize sensors after a short delay (or immediately)
    setTimeout(() => {
      if (!Sensors.isOrientationEnabled) { // Check if Sensors are already initialized
        console.log('Auto-start: Initializing Sensors.');
        initializeSensors();
      }
    }, 1000); // Adjust delay as needed (1 second here)
  
    // Add event listeners for manual triggering via click and touchstart
    appElement.addEventListener('click', handleUserGesture);
    appElement.addEventListener('touchstart', handleUserGesture);
  
    console.log("Added event listeners for 'click' and 'touchstart' on #request_orient.");
  }
  

  /**
   * Initializes the day-night cycle.
   */
  initDayNightCycle() {
    this.dayNightCycle = new DayNightCycle(this.scene, {
      skyScale: 450000,
      directionalLightColor: 0xffffff,
      directionalLightIntensityDay: 1,
      directionalLightIntensityNight: 0.1,
      directionalLightPosition: new THREE.Vector3(0, 200, -200),
      directionalLightTarget: new THREE.Vector3(-5, 0, 0),
      shadowMapSize: new THREE.Vector2(1024, 1024),
      skyTurbidity: 0.8,
      skyRayleigh: 0.2,
      skyMieCoefficient: 0.005,
      skyMieDirectionalG: 0.6,
      ambientLightColor: 0xffffff,
      ambientLightIntensityDay: 0.8,
      ambientLightIntensityNight: 0.5,
      transitionSpeed: 0.01, // Speed of transitions
      updateInterval: 60 * 1000 // Update every minute
    })
  }

  /**
   * Initializes Terrain and ensures it's ready before initializing dependent classes.
   * @returns {Promise} - Resolves when Terrain is initialized.
   */
  initTerrain() {
    return new Promise((resolve, reject) => {
      // Attempt to get user's geolocation
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          position => {
            window.latitude = position.coords.latitude
            window.longitude = position.coords.longitude

            // Initialize Terrain instance
            this.terrain = new Terrain(
              this.scene,
              {},
              {
                originLatitude: window.latitude,
                originLongitude: window.longitude,
                size: CONFIG.terrain.size,
                segments: CONFIG.terrain.segments,
                scaleMultiplier: CONFIG.terrain.scaleMultiplier,
                gridSizeMeters: CONFIG.terrain.gridSizeMeters,
                gridResolution: CONFIG.terrain.gridResolution,
                elevationAPI: CONFIG.terrain.elevationAPI
              }
            )

            console.log('Terrain initialized successfully.')
            resolve()
          },
          error => {
            console.error('Geolocation error:', error)

            // Fallback to default origin if geolocation fails
            this.terrain = new Terrain(
              this.scene,
              {},
              {
                originLatitude: 0,
                originLongitude: 0,
                size: CONFIG.terrain.size,
                segments: CONFIG.terrain.segments,
                scaleMultiplier: CONFIG.terrain.scaleMultiplier,
                gridSizeMeters: CONFIG.terrain.gridSizeMeters,
                gridResolution: CONFIG.terrain.gridResolution,
                elevationAPI: CONFIG.terrain.elevationAPI
              }
            )

            console.log('Terrain initialized with default origin.')
            resolve() // Proceed even if geolocation fails
          }
        )
      } else {
        console.error('Geolocation not supported.')

        // Fallback to default origin if geolocation is not supported
        this.terrain = new Terrain(
          this.scene,
          {},
          {
            originLatitude: 0,
            originLongitude: 0,
            size: CONFIG.terrain.size,
            segments: CONFIG.terrain.segments,
            scaleMultiplier: CONFIG.terrain.scaleMultiplier,
            gridSizeMeters: CONFIG.terrain.gridSizeMeters,
            gridResolution: CONFIG.terrain.gridResolution,
            elevationAPI: CONFIG.terrain.elevationAPI
          }
        )

        console.log('Terrain initialized with default origin.')
        resolve() // Proceed even if geolocation is not supported
      }
    })
  }

  /**
   * Initializes socket event listeners, now dependent on Terrain being ready.
   */
  initSocketEvents() {
    console.warn('[Socket] Connected to server.')
    this.multiplayer = new Multiplayer(this.socket, this.scene, this.terrain)
  }

  /**
   * Binds UI-related events.
   */
  bindUIEvents() {
    document.addEventListener('click', this.handleUserInteraction.bind(this), {
      once: true
    })
    document.addEventListener(
      'keydown',
      this.handleUserInteraction.bind(this),
      { once: true }
    )
    window.addEventListener(
      'beforeunload',
      this.savePositionToLocalStorage.bind(this)
    )

    // Encrypt/Decrypt Button
    const encryptDecryptBtn = document.getElementById('encryptDecryptBtn')
    if (encryptDecryptBtn) {
      encryptDecryptBtn.addEventListener('click', async () => {
        const passwordInput = document.getElementById('password')
        const password = passwordInput.value.trim()

        if (!password) {
          console.error('Password cannot be empty.')
          UI.updateField('encryptDecryptBtn', 'Password cannot be empty.')
          return
        }

        Storage.save(CONFIG.localStorageKeys.encryptedPassword, password)
        await this.encryptAndEmitLatLon()
      })
      console.log('Encrypt/Decrypt button event listener added.')
    } else {
      console.warn('Encrypt/Decrypt button not found in the DOM.')
    }

    // Password Input Change
    const passwordField = document.getElementById('password')
    if (passwordField) {
      passwordField.addEventListener('change', async () => {
        const newPassword = passwordField.value.trim()

        if (!newPassword) {
          console.error('Password cannot be empty.')
          return
        }

        Storage.save(CONFIG.localStorageKeys.encryptedPassword, newPassword)
        await this.encryptAndEmitLatLon()
      })
      console.log('Password input change event listener added.')
    } else {
      console.warn('Password input field not found in the DOM.')
    }

    // Load Saved Password on DOM Content Loaded
    window.addEventListener('DOMContentLoaded', () => {
      if (passwordField) {
        const savedPassword = Storage.load(
          CONFIG.localStorageKeys.encryptedPassword
        )
        if (savedPassword) {
          passwordField.value = savedPassword
          console.log('Loaded saved password into the input field.')
        } else {
          console.log('No saved password found.')
        }
      }
    })
  }

  /**
   * Handles user interactions to resume AudioContext.
   */
  handleUserInteraction() {
    if (this.listener && this.listener.context.state === 'suspended') {
      this.listener.context
        .resume()
        .then(() => {
          console.log('AudioContext resumed on user interaction.')
        })
        .catch(err => {
          console.error('Error resuming AudioContext:', err)
        })
    }
  }

  /**
   * Encrypts and emits latitude and longitude data.
   */
  async encryptAndEmitLatLon() {
    const latitude = window.latitude
    const longitude = window.longitude
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      console.error(
        'window.latitude and window.longitude must be set to numerical values.'
      )
      return
    }

    const password = Storage.load(CONFIG.localStorageKeys.encryptedPassword)
    if (!password) {
      console.error('Password not found. Cannot encrypt position data.')
      return
    }

    try {
      const encryptedPackageStr = await Encryption.encryptLatLon(
        latitude,
        longitude,
        password
      )
      console.log('Encrypted Package:', encryptedPackageStr)
      this.socket.emit('position', encryptedPackageStr)
    } catch (error) {
      console.error('Encryption failed:', error)
    }
  }

  /**
   * Saves the camera's position to localStorage.
   */
  savePositionToLocalStorage() {
    if (!this.camera) return

    const pos = {
      x: this.camera.position.x,
      y: this.camera.position.y, // optional if you also care about vertical
      z: this.camera.position.z,
      rotation: this.getCameraYaw() // yaw in radians
    }

    Storage.save(CONFIG.localStorageKeys.lastPosition, pos)
    //console.log('Saved camera position to LS:', pos);
  }

  /**
   * Loads the camera's position from localStorage.
   * @returns {Object|null} - The saved position or null if not found.
   */
  loadPositionFromLocalStorage() {
    return Storage.load(CONFIG.localStorageKeys.lastPosition)
  }

  /**
   * Normalizes an angle to the range [-π, π].
   * @param {number} angle - The angle in radians.
   * @returns {number} - The normalized angle.
   */
  normalizeAngle(angle) {
    return Utils.normalizeAngle(angle)
  }

  /**
   * Retrieves the camera's yaw rotation.
   * @returns {number} - The yaw angle in radians.
   */
  getCameraYaw() {
    const euler = new THREE.Euler().setFromQuaternion(
      this.camera.quaternion,
      'YXZ'
    )
    const yaw = euler.y
    return Utils.normalizeAngle(yaw)
  }

  /**
   * Emits movement data if there are changes.
   * @param {Object} newState - The new state data.
   */
  emitMovementIfChanged(newState) {
    const loadedId = this.multiplayer.myId
    newState.id = loadedId
    const newString = JSON.stringify(newState)
    const oldString = this.lastEmittedState
      ? JSON.stringify(this.lastEmittedState)
      : null
    //console.warn(`New State: ${newString}`);
    if (newString !== oldString) {
      //console.warn('[Socket] Emitting movement:', newState);
      this.socket.emit('move', newState)
      this.lastEmittedState = newState
    }
  }

  /**
   * Reports the player's current geographic position.
   */
  reportPosition() {
    if (!this.multiplayer.terrain || !this.localModel) return

    // Extract the local model's current x and z positions
    const userX = this.localModel.position.x
    const userZ = this.localModel.position.z

    // Find the closest grid point
    const closestPoint = this.multiplayer.terrain.findClosestGridPoint(
      userX,
      userZ
    )

    if (closestPoint) {
      const formattedLat = parseFloat(closestPoint.latitude.toFixed(5))
      const formattedLon = parseFloat(closestPoint.longitude.toFixed(5))

      // Update window.latitudeDelta and window.longitudeDelta
      window.latitudeDelta = formattedLat
      window.longitudeDelta = formattedLon

      // Update the HTML element with the formatted latitude and longitude
      UI.updateField('position', `Lat: ${formattedLat}, Lon: ${formattedLon}`)
    } else {
      // Handle cases where no closest point is found
      UI.updateField('position', 'Position: Unknown')
    }
  }

  /**
   * Updates the camera's orientation based on device sensors.
   */
  updateCameraOrientation() {
    // 1. Pull orientation data from window.orientationGlobal if available
    if (
      window.orientationGlobal &&
      typeof window.orientationGlobal === 'object'
    ) {
      Sensors.orientationData.alpha =
        parseFloat(window.orientationGlobal.alpha) || 0; // 0..360 degrees
      Sensors.orientationData.beta =
        parseFloat(window.orientationGlobal.beta) || 0; // -180..180 degrees
      Sensors.orientationData.gamma =
        parseFloat(window.orientationGlobal.gamma) || 0; // -90..90 degrees
    }
  
    // 2. Access orientation data directly from Sensors.orientationData
    const alphaDeg = Sensors.orientationData.alpha || 0; // 0..360 degrees
    const betaDeg = Sensors.orientationData.beta || 0; // -180..180 degrees
    const gammaDeg = Sensors.orientationData.gamma || 0; // -90..90 degrees
  
    // 3. Fix decimal places for UI display
    const alphaConstraint = alphaDeg.toFixed(2);
    const betaConstraint = betaDeg.toFixed(2);
    const gammaConstraint = gammaDeg.toFixed(2);
  
    // 4. Update UI fields with orientation data
    UI.updateField('Orientation_a', alphaConstraint);
    UI.updateField('Orientation_b', betaConstraint);
    UI.updateField('Orientation_g', gammaConstraint);
  
    // 5. Optional: Replace alerts with console logs for debugging
    console.log(
      `Orientation Data - Alpha: ${alphaDeg}, Beta: ${betaDeg}, Gamma: ${gammaDeg}`
    );
  
    // 6. Check if compass data is available and accurate
    const hasCompass =
      Sensors.orientationData.webkitCompassHeading !== undefined &&
      Sensors.orientationData.webkitCompassAccuracy !== undefined &&
      Math.abs(Sensors.orientationData.webkitCompassAccuracy) <= 10; // Adjust threshold as needed
  
    let yawDeg;
  
    if (hasCompass) {
      // 6.a. Use compass heading as yaw
      yawDeg = Sensors.orientationData.webkitCompassHeading;
      console.log(`Using compass heading for yaw: ${yawDeg} degrees`);
    } else {
      // 6.b. Fallback: Calculate yaw using alpha
      yawDeg = alphaDeg;
      console.log(`Using alpha for yaw: ${yawDeg} degrees`);
    }
  
    // 7. Convert degrees to radians
    const yawRad = THREE.MathUtils.degToRad(yawDeg);
    const pitchRad = THREE.MathUtils.degToRad(betaDeg);
    const rollRad = THREE.MathUtils.degToRad(gammaDeg);
  
    // 8. Determine the screen orientation (0, 90, 180, 270 degrees)
    const screenOrientationDeg = window.orientation || 0;
    const screenOrientationRad = THREE.MathUtils.degToRad(screenOrientationDeg);
  
    // 9. Adjust yaw based on screen orientation
    const adjustedYawRad = yawRad - screenOrientationRad;
  
    // 10. Create quaternions for each rotation
    const quaternionYaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      adjustedYawRad
    );
    const quaternionPitch = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      pitchRad
    );
    const quaternionRoll = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      rollRad
    );
  
    // 11. Combine the quaternions: Yaw * Pitch * Roll
    const quaternion = new THREE.Quaternion()
      .multiply(quaternionYaw)
      .multiply(quaternionPitch)
      .multiply(quaternionRoll);
  
    // 12. Apply the quaternion to the camera
    this.camera.quaternion.copy(quaternion);
  }
  
  
  
  /**
   * Handles window resize events.
   */
  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
  }

  /**
   * Initializes socket event listeners (now handled in initSocketEvents).
   */

  /**
   * Sets the local player's action and manages animations.
   * @param {string} action - The action to set ('idle', 'walk', 'run').
   */
  setLocalAction(action) {
    //console.warn(`Setting local action: ${action}`);
    if (this.currentAction !== action) {
      if (this.localActions && this.localActions[this.currentAction]) {
        this.localActions[this.currentAction].fadeOut(0.5)
      }
      if (this.localActions && this.localActions[action]) {
        this.localActions[action].reset().fadeIn(0.5).play()
        if (action === 'walk' || action === 'run') {
          this.localActions[action].timeScale = 1
        }
      }
      this.currentAction = action
      //console.warn(`Local Action: ${action}`);
    }
  }

  /**
   * Loads the local player model.
   */
  loadLocalModel() {
    console.warn('Loading local model...')
    // Check if a VR session is active; if so, do not load the local model
    if (this.renderer.xr.isPresenting) {
      console.log(
        'VR session active. Skipping loading of local model to prevent camera obstruction.'
      )
      return
    }
    const spawnRecall = this.loadPositionFromLocalStorage()
    const spawnX = spawnRecall.x
    const spawnZ = spawnRecall.z
    const spawnRotation = spawnRecall.rotation
    const finalSpawn = { x: spawnX, z: spawnZ, rotation: spawnRotation } // Replace with actual spawn logic
    console.warn('Set Spawn Location: ', finalSpawn)

    const loader = new GLTFLoader()
    console.warn('Loader Debug: ', loader)

    loader.load(
      CONFIG.modelPath,
      gltf => {
        this.localModel = gltf.scene

        console.warn('Local Model: ', CONFIG.modelPath)
        // Set the model's position based on finalSpawn
        this.localModel.position.set(finalSpawn.x, 0, finalSpawn.z)
        console.warn('Local Model Position: ', this.localModel.position)
        // Set the model's rotation around the Y-axis
        this.localModel.rotation.y = finalSpawn.rotation || 0
        console.warn('Local Model Rotation: ', this.localModel.rotation.y)
        // Add the model to the scene
        this.scene.add(this.localModel)
        console.warn('Scene: ', this.scene)
        // Enable shadow casting for all meshes within the model
        this.localModel.traverse(obj => {
          if (obj.isMesh) obj.castShadow = true
        })

        // Setup localMixer for animations
        this.localMixer = new THREE.AnimationMixer(this.localModel)
        this.localActions = {} // Initialize localActions
        gltf.animations.forEach(clip => {
          this.localActions[clip.name] = this.localMixer.clipAction(clip)
          this.localActions[clip.name].loop = THREE.LoopRepeat
          if (clip.name === 'idle') this.localActions[clip.name].play()
        })
        console.warn(this.multiplayer.myId)
        const loadedId = this.multiplayer.myId
        // Inform the server about the player joining
        this.socket.emit('player_joined', {
          x: finalSpawn.x,
          z: finalSpawn.z,
          rotation: finalSpawn.rotation,
          action: 'idle',
          id: loadedId // include localStorage ID
        })
      },
      undefined,
      err => console.error('Error loading local model:', err)
    )
  }

  /**
   * Initializes the render loop.
   */
  animate() {
    this.clock = new THREE.Clock()
    this.renderer.setAnimationLoop(() => {
      const delta = this.clock.getDelta()

      // 2) VRControllers: do the raycast
      if (this.vrControllers) {
        this.vrControllers.update()
      }
      // Update local animations
      if (this.localMixer) {
        this.localMixer.update(delta)
      }

      // Update camera orientation based on device orientation data, if enabled
      if (Sensors.isOrientationEnabled) {
        this.updateCameraOrientation()
      }

      // Update day-night cycle
      this.dayNightCycle.update()

      // Handle movements
      if (this.localModel) {
        // Desktop Mode
        this.movement.moveCharacter(delta)
      }

      // Render
      if (this.renderer.xr.isPresenting) {
        // VR Mode
        this.renderer.render(this.scene, this.camera)
      } else {
        // Desktop/Mobile Mode
        this.composer.render()
      }

      // Update remote players' animations
      if (this.multiplayer && this.multiplayer.players) {
        Object.values(this.multiplayer.players).forEach(p => {
          if (p.mixer) p.mixer.update(delta)
        })
      }

      // Render dynamic terrain points
      //this.terrain.renderTerrainPoints();
    })

    console.log('Render loop started.')
  }
}

// ------------------------------
// Initialization
// ------------------------------
window.addEventListener('DOMContentLoaded', () => {
  const app = new App()
  console.log('App initialized.')
})
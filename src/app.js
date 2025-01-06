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
function fileExists (path) {
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
  static normalizeAngle (angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle))
  }

  static lerpAngle (currentAngle, targetAngle, alpha) {
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

  static arrayBufferToBase64 (buffer) {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    bytes.forEach(b => (binary += String.fromCharCode(b)))
    return window.btoa(binary)
  }

  static base64ToArrayBuffer (base64) {
    const binary = window.atob(base64)
    const bytes = new Uint8Array(binary.length)
    Array.from(binary).forEach((char, i) => {
      bytes[i] = char.charCodeAt(0)
    })
    return bytes.buffer
  }

  static calculateDistance (lat1, lon1, lat2, lon2) {
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

  static mapLatitudeToZ (latitude, originLatitude, scale) {
    return (latitude - originLatitude) * (111320 * scale)
  }

  static mapLongitudeToX (longitude, originLongitude, scale) {
    return (longitude - originLongitude) * (110540 * scale)
  }

  static calculateDistanceSq (x1, z1, x2, z2) {
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
  static async encryptLatLon (latitude, longitude, password) {
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
  static async decryptLatLon (encryptedPackageStr, password) {
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
  static save (key, value) {
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
  static load (key) {
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
  static remove (key) {
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
  };

  static isOrientationEnabled = false;
  static isMotionEnabled = false;

  /**
   * Initializes sensor event listeners based on device type and permissions.
   * This method should be called in response to a user interaction (e.g., button click).
   */
  static async initialize() {
    try {
      console.log('Initializing Sensors...');

      if (!Sensors.isMobileDevice()) {
        console.log('Non-mobile device detected. Device Orientation and Motion not enabled.');
        //alert('Device Orientation and Motion features are disabled on non-mobile devices.');
        return;
      }

      // Request orientation and motion permissions if needed
      const orientationGranted = await Sensors.requestOrientationPermission();
      const motionGranted = await Sensors.requestMotionPermission();

      // Attach event listeners based on granted permissions
      if (orientationGranted) {
        window.addEventListener('deviceorientation', Sensors.handleOrientation);
        Sensors.isOrientationEnabled = true;
        console.log('DeviceOrientation event listener added.');
        alert('Device Orientation permission granted and enabled.');
      } else {
        console.warn('DeviceOrientation permission not granted.');
        alert('Device Orientation permission denied.');
      }

      if (motionGranted) {
        window.addEventListener('devicemotion', Sensors.handleMotion);
        Sensors.isMotionEnabled = true;
        console.log('DeviceMotion event listener added.');
        alert('Device Motion permission granted and enabled.');
      } else {
        console.warn('DeviceMotion permission not granted.');
        alert('Device Motion permission denied.');
      }
    } catch (err) {
      console.error('Error initializing Sensors:', err);
      alert('Error initializing sensors. Please try again.');
    }
  }

  /**
   * Enhanced device detection to determine if the device is mobile.
   * Combines User-Agent sniffing with touch support detection.
   * @returns {boolean} - True if the device is mobile, false otherwise.
   */
  static isMobileDevice() {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const isMobileUA = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);
    return isMobileUA && hasTouch;
  }

  /**
   * Requests device orientation permission (required for iOS 13+).
   * This method should be called in response to a user interaction.
   * @returns {Promise<boolean>} - Resolves to true if permission is granted, false otherwise.
   */
  static async requestOrientationPermission() {
    // Check if permission is needed (iOS 13+)
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const response = await DeviceOrientationEvent.requestPermission();
        if (response === 'granted') {
          return true;
        } else {
          return false;
        }
      } catch (error) {
        console.error('Error requesting DeviceOrientation permission:', error);
        return false;
      }
    } else {
      // Permission not required
      return true;
    }
  }

  /**
   * Requests device motion permission (required for iOS 13+).
   * This method should be called in response to a user interaction.
   * @returns {Promise<boolean>} - Resolves to true if permission is granted, false otherwise.
   */
  static async requestMotionPermission() {
    // Check if permission is needed (iOS 13+)
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      try {
        const response = await DeviceMotionEvent.requestPermission();
        if (response === 'granted') {
          return true;
        } else {
          return false;
        }
      } catch (error) {
        console.error('Error requesting DeviceMotion permission:', error);
        return false;
      }
    } else {
      // Permission not required
      return true;
    }
  }

  /**
   * Handles device orientation events.
   * @param {DeviceOrientationEvent} event
   */
  static handleOrientation(event) {
    try {
      Sensors.orientationData.alpha =
        event.alpha !== null ? event.alpha : Sensors.orientationData.alpha;
      Sensors.orientationData.beta =
        event.beta !== null ? event.beta : Sensors.orientationData.beta;
      Sensors.orientationData.gamma =
        event.gamma !== null ? event.gamma : Sensors.orientationData.gamma;

      if (event.webkitCompassHeading !== undefined) {
        Sensors.orientationData.webkitCompassHeading = event.webkitCompassHeading;
        Sensors.orientationData.webkitCompassAccuracy = event.webkitCompassAccuracy;
      }

      // Example: Update UI elements with orientation data
      Sensors.updateOrientationUI();
    } catch (err) {
      console.error('Error in handleOrientation:', err);
      alert('Error handling orientation data.');
    }
  }

  /**
   * Handles device motion events.
   * @param {DeviceMotionEvent} event
   */
  static handleMotion(event) {
    try {
      // Example: Update UI with motion data
      Sensors.updateMotionUI(event.acceleration, event.rotationRate);
      console.log('DeviceMotionEvent:', event);
    } catch (err) {
      console.error('Error in handleMotion:', err);
      alert('Error handling motion data.');
    }
  }

  /**
   * Updates the UI with the latest orientation data.
   * Replace the implementation with your actual UI update logic.
   */
  static updateOrientationUI() {
    // Example implementation:
    const alphaEl = document.getElementById('Orientation_a');
    const betaEl = document.getElementById('Orientation_b');
    const gammaEl = document.getElementById('Orientation_g');

    if (alphaEl) alphaEl.textContent = `Alpha: ${Sensors.orientationData.alpha}`;
    if (betaEl) betaEl.textContent = `Beta: ${Sensors.orientationData.beta}`;
    if (gammaEl) gammaEl.textContent = `Gamma: ${Sensors.orientationData.gamma}`;
  }

  /**
   * Updates the UI with the latest motion data.
   * Replace the implementation with your actual UI update logic.
   * @param {Object} acceleration - The acceleration data from the device.
   * @param {Object} rotationRate - The rotation rate data from the device.
   */
  static updateMotionUI(acceleration, rotationRate) {
    // Example implementation:
    const accXEl = document.getElementById('Motion_accX');
    const accYEl = document.getElementById('Motion_accY');
    const accZEl = document.getElementById('Motion_accZ');

    const rotXEl = document.getElementById('Motion_rotX');
    const rotYEl = document.getElementById('Motion_rotY');
    const rotZEl = document.getElementById('Motion_rotZ');

    if (accXEl) accXEl.textContent = `Acceleration X: ${acceleration.x}`;
    if (accYEl) accYEl.textContent = `Acceleration Y: ${acceleration.y}`;
    if (accZEl) accZEl.textContent = `Acceleration Z: ${acceleration.z}`;

    if (rotXEl) rotXEl.textContent = `Rotation Rate X: ${rotationRate.alpha}`;
    if (rotYEl) rotYEl.textContent = `Rotation Rate Y: ${rotationRate.beta}`;
    if (rotZEl) rotZEl.textContent = `Rotation Rate Z: ${rotationRate.gamma}`;
  }
}

// Initialize Sensors when a user interacts with the page
// For example, attach to an existing button's click event
document.addEventListener('DOMContentLoaded', () => {
  const startSensorsButton = document.getElementById('request_orient');
  if (startSensorsButton) {
    startSensorsButton.addEventListener('click', () => {
      Sensors.initialize();
    });
  } else {
    // If there's no existing button, you might need to create one or prompt the user to interact
    console.warn('No element with ID "startSensors" found. Sensors will not initialize automatically.');
    alert('Please click the "Start Sensors" button to enable Device Orientation and Motion features.');
  }
});



// ------------------------------
// UI Module
// ------------------------------
class UI {
  /**
   * Updates the innerHTML of an element with the given ID.
   * @param {string} elementId - The ID of the HTML element to update.
   * @param {string} content - The content to set as innerHTML.
   */
  static updateField (elementId, content) {
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
  static updateFieldIfNotNull (elementId, value, decimals) {
    if (value !== null && value !== undefined) {
      const formattedValue = value.toFixed(decimals)
      UI.updateField(elementId, formattedValue)
    }
  }

  /**
   * Increments an event count display for debugging purposes.
   */
  static incrementEventCount () {
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
  constructor (scene, options = {}) {
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

  initLocation () {
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

  setDefaultSunTimes () {
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

  calculateSunTimes () {
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

  initDirectionalLight () {
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

  initSky () {
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

  initAmbientLight () {
    // Add Ambient Light
    this.ambientLight = new THREE.AmbientLight(
      this.options.ambientLightColor,
      this.options.ambientLightIntensityNight
    )
    this.scene.add(this.ambientLight)
  }

  updateSunPosition () {
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

  update () {
    // Update sun position periodically
    this.updateSunPosition()
  }
}
/* 
 * Final Terrain Class with On-Demand Ring Expansion in findClosestGridPoint
 * - Starts with up to 10 rings from center 
 * - Center fan (0->1), two-pointer ring stitching for ring k->k+1 
 * - Skips large triangles (edge/area threshold), optional overshadow check
 * - If user’s (x,z) is near the edge (outer ring), we automatically build a new ring
 *   right inside findClosestGridPoint.
 */

class Terrain {
  constructor(scene, options = {}, config = {}) {
    this.scene = scene
    this.config = config

    // Center lat/lon
    this.centerLatitude = config.originLatitude || 0
    this.centerLongitude = config.originLongitude || 0

    // Rings / fetch / scale config
    this.scaleMultiplier = config.scaleMultiplier || 1
    this.elevationAPI = config.elevationAPI || 'https://epqs.nationalmap.gov/v1/json'

    // We'll build up to 'maxRings' initially in generateRingsSequentially,
    // but we can keep expanding beyond if the user hits the edge.
    this.maxRings = config.maxRings || 10
    this.gridCellSizeMeters = config.cellSizeMeters || 25
    this.fetchConcurrency = config.fetchConcurrency || 6
    this.fetchRetries = config.fetchRetries || 3

    // Large triangle checks
    this.maxEdgeMeters = config.maxEdgeMeters || 100
    this.maxTriangleArea = config.maxTriangleArea || 2500 // square meters in xz-plane
    this.overshadowCheck = !!config.overshadowCheck

    // Local storage keys
    this.LS_TERRAIN_POINTS_KEY = CONFIG.localStorageKeys.terrainPoints

    // Data
    this.savedPoints = []
    this.ringPoints = []

    // Scene / geometry
    this.sceneChunks = []
    this.terrainPointCloud = null
    this.terrainGeometry = null
    this.terrainMaterial = null
    this.currentPointCount = 0

    // We'll track how many rings we actually have built so far.
    // After the initial build, this will match 'maxRings', 
    // then can grow beyond if needed.
    this.currentMaxRing = 0

    // Load saved data from localStorage
    this.savedPoints = this.loadPointsFromLocalStorage()

    // Initialize point cloud
    this.initializePointCloud()

    // Generate the initial rings (0..maxRings)
    this.generateRingsSequentially()
  }

  // -----------------------------------------------
  // Local Storage
  // -----------------------------------------------
  loadPointsFromLocalStorage() {
    const existing = Storage.load(this.LS_TERRAIN_POINTS_KEY) || []
    return existing
  }

  savePointsToLocalStorage(pointsBatch) {
    const existing = Storage.load(this.LS_TERRAIN_POINTS_KEY) || []
    const merged = existing.concat(pointsBatch)
    Storage.save(this.LS_TERRAIN_POINTS_KEY, merged)
    this.savedPoints = merged
  }

  // -----------------------------------------------
  // Point Cloud
  // -----------------------------------------------
  initializePointCloud() {
    // Over-allocate for initial + potential expansions
    const maxPoints = (this.maxRings + 20) * 8 * 4 + 100
    const positions = new Float32Array(maxPoints * 3)
    const colors = new Float32Array(maxPoints * 3)

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
      size: 0,
      vertexColors: true,
      transparent: true,
      opacity: 0
    })

    this.terrainPointCloud = new THREE.Points(this.terrainGeometry, this.terrainMaterial)
    this.scene.add(this.terrainPointCloud)
    this.currentPointCount = 0
  }

  addPointsToPointCloud(newPoints) {
    if (!this.terrainPointCloud) return

    const pos = this.terrainPointCloud.geometry.attributes.position.array
    const col = this.terrainPointCloud.geometry.attributes.color.array

    newPoints.forEach(p => {
      const x = Utils.mapLongitudeToX(p.longitude, this.centerLongitude, this.scaleMultiplier)
      const y = p.elevation * this.scaleMultiplier
      const z = Utils.mapLatitudeToZ(p.latitude, this.centerLatitude, this.scaleMultiplier)

      const base = this.currentPointCount * 3
      pos[base] = x
      pos[base + 1] = y
      pos[base + 2] = z

      // color gradient from 0 => blue, 100 => red
      const norm = Math.min(Math.max(p.elevation, 0), 100) / 100
      const c = new THREE.Color().lerpColors(
        new THREE.Color(0x0000ff),
        new THREE.Color(0xff0000),
        norm
      )
      col[base] = c.r
      col[base + 1] = c.g
      col[base + 2] = c.b

      this.currentPointCount++
    })

    this.terrainPointCloud.geometry.attributes.position.needsUpdate = true
    this.terrainPointCloud.geometry.attributes.color.needsUpdate = true
  }

  // -----------------------------------------------
  // Ring Generation
  // -----------------------------------------------
  async generateRingsSequentially() {
    for (let ringIndex = 0; ringIndex <= this.maxRings; ringIndex++) {
      await this.buildRing(ringIndex)
    }
    // after building 0..maxRings, set currentMaxRing
    this.currentMaxRing = this.maxRings
  }

  /**
   * Builds a single ring:
   *  - fetches its lat/lon
   *  - fetches elevation
   *  - saves + pointcloud
   *  - builds center fan if ring1
   *  - or ring band if ring >=2
   */
  async buildRing(ringIndex) {
    const ringLatLon = this.generateRingLatLon(ringIndex)
    if (!ringLatLon.length) return

    const ringData = await this.fetchRingElevation(ringLatLon)
    this.savePointsToLocalStorage(ringData)
    this.ringPoints[ringIndex] = ringData
    this.addPointsToPointCloud(ringData)

    // ring 0 => single center
    // ring 1 => center fan
    if (ringIndex === 1) {
      this.buildCenterFan(0, 1)
    } else if (ringIndex >= 2) {
      // build ring band from ringIndex-1 -> ringIndex
      this.buildRingBand(ringIndex - 1, ringIndex)
    }
  }

  generateRingLatLon(ringIndex) {
    if (ringIndex === 0) {
      return [{ latitude: this.centerLatitude, longitude: this.centerLongitude }]
    }

    const points = []
    const step = this.gridCellSizeMeters

    for (let row = -ringIndex; row <= ringIndex; row++) {
      for (let col = -ringIndex; col <= ringIndex; col++) {
        if (Math.abs(row) !== ringIndex && Math.abs(col) !== ringIndex) continue

        const latOffset = (row * step) / 111000
        const lonOffset =
          (col * step) /
          (111000 * Math.cos(THREE.MathUtils.degToRad(this.centerLatitude)))

        const lat = this.centerLatitude + latOffset
        const lon = this.centerLongitude + lonOffset
        points.push({ latitude: lat, longitude: lon })
      }
    }
    return points
  }

  buildCenterFan(ring0Index, ring1Index) {
    const centerRing = this.ringPoints[ring0Index] || []
    const perimeterRing = this.ringPoints[ring1Index] || []
    if (!centerRing.length || !perimeterRing.length) {
      console.warn(`Cannot build center fan (missing ring0 or ring1).`)
      return
    }

    const centerPt = centerRing[0]
    const sortedRing = this.sortRingByAngle(perimeterRing)
    const { geometry, material, wireMaterial } = this.buildFanGeometry(centerPt, sortedRing)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.receiveShadow = true
    this.scene.add(mesh)
    this.sceneChunks.push(mesh)

    const wire = new THREE.Mesh(geometry, wireMaterial)
    this.scene.add(wire)
    this.sceneChunks.push(wire)

    console.log('Built center fan (0->1).')
  }

  buildFanGeometry(centerPt, perimeter) {
    // same final code logic for building fan
    const cx = Utils.mapLongitudeToX(centerPt.longitude, this.centerLongitude, this.scaleMultiplier)
    const cy = centerPt.elevation * this.scaleMultiplier || 0
    const cz = Utils.mapLatitudeToZ(centerPt.latitude, this.centerLatitude, this.scaleMultiplier)

    const ringXYZ = perimeter.map(pt => {
      const x = Utils.mapLongitudeToX(pt.longitude, this.centerLongitude, this.scaleMultiplier)
      const y = pt.elevation * this.scaleMultiplier
      const z = Utils.mapLatitudeToZ(pt.latitude, this.centerLatitude, this.scaleMultiplier)
      return { x, y, z }
    })

    const n = ringXYZ.length
    const totalCount = n + 1
    const vertices = new Float32Array(totalCount * 3)
    const colors = new Float32Array(totalCount * 3)
    const indices = []

    // index 0 => center
    vertices[0] = cx
    vertices[1] = cy
    vertices[2] = cz
    const cNorm = Math.min(Math.max(cy, 0), 200) / 200
    const cColor = new THREE.Color().lerpColors(
      new THREE.Color(0x000000),
      new THREE.Color(0xffffff),
      cNorm
    )
    colors[0] = cColor.r
    colors[1] = cColor.g
    colors[2] = cColor.b

    // perimeter => 1..n
    for (let i = 0; i < n; i++) {
      const base = (i + 1) * 3
      const { x, y, z } = ringXYZ[i]
      vertices[base] = x
      vertices[base + 1] = y
      vertices[base + 2] = z

      const norm = Math.min(Math.max(y, 0), 200) / 200
      const cc = new THREE.Color().lerpColors(
        new THREE.Color(0x000000),
        new THREE.Color(0xffffff),
        norm
      )
      colors[base] = cc.r
      colors[base + 1] = cc.g
      colors[base + 2] = cc.b
    }

    // build fan => tri(0, i, i+1)
    for (let i = 1; i <= n; i++) {
      const i2 = (i < n) ? i + 1 : 1
      indices.push(0, i, i2)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      metalness: 0.2,
      roughness: 0.7
    })
    const wireMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      wireframe: true,
      transparent: true,
      opacity: 0.4
    })

    return { geometry, material, wireMaterial }
  }

  buildRingBand(innerIndex, outerIndex) {
    const innerPts = this.ringPoints[innerIndex] || []
    const outerPts = this.ringPoints[outerIndex] || []
    if (!innerPts.length || !outerPts.length) {
      console.warn(`Cannot build ring band from ${innerIndex} to ${outerIndex}. Missing data.`)
      return
    }

    const sortedInner = this.sortRingByAngle(innerPts)
    const sortedOuter = this.sortRingByAngle(outerPts)

    const { geometry, material, wireMaterial } = 
      this.buildAngleStripTwoPointer(sortedInner, sortedOuter)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.receiveShadow = true
    this.scene.add(mesh)
    this.sceneChunks.push(mesh)

    const wire = new THREE.Mesh(geometry, wireMaterial)
    this.scene.add(wire)
    this.sceneChunks.push(wire)

    console.log(
      `Built ring band between ring ${innerIndex} & ${outerIndex}, skipping large/overshadow triangles.`
    )
  }

  sortRingByAngle(ringPoints) {
    return ringPoints
      .map(pt => {
        const x = Utils.mapLongitudeToX(pt.longitude, this.centerLongitude, this.scaleMultiplier)
        const z = Utils.mapLatitudeToZ(pt.latitude, this.centerLatitude, this.scaleMultiplier)
        const angle = Math.atan2(z, x)
        return { ...pt, _angle: angle }
      })
      .sort((a, b) => a._angle - b._angle)
      .map(pt => {
        delete pt._angle
        return pt
      })
  }

  // Two-pointer angle merge + skip large / overshadowing triangles
  buildAngleStripTwoPointer(inner, outer) {
    // same final code: iArr, oArr, fill geometry, skip large triangles
    // ...
    const iArr = inner.map(pt => ({
      x: Utils.mapLongitudeToX(pt.longitude, this.centerLongitude, this.scaleMultiplier),
      y: pt.elevation * this.scaleMultiplier,
      z: Utils.mapLatitudeToZ(pt.latitude, this.centerLatitude, this.scaleMultiplier),
      ...pt
    }))
    const oArr = outer.map(pt => ({
      x: Utils.mapLongitudeToX(pt.longitude, this.centerLongitude, this.scaleMultiplier),
      y: pt.elevation * this.scaleMultiplier,
      z: Utils.mapLatitudeToZ(pt.latitude, this.centerLatitude, this.scaleMultiplier),
      ...pt
    }))

    const totalCount = iArr.length + oArr.length
    const vertices = new Float32Array(totalCount * 3)
    const colors = new Float32Array(totalCount * 3)
    const indices = []

    // fill arrays
    iArr.forEach((p, i) => {
      const base = i * 3
      vertices[base] = p.x
      vertices[base + 1] = p.y
      vertices[base + 2] = p.z
      const norm = Math.min(Math.max(p.y, 0), 200) / 200
      const c = new THREE.Color().lerpColors(new THREE.Color(0x000000), new THREE.Color(0xffffff), norm)
      colors[base] = c.r
      colors[base + 1] = c.g
      colors[base + 2] = c.b
    })
    const offsetOuter = iArr.length

    oArr.forEach((p, j) => {
      const idx = offsetOuter + j
      const base = idx * 3
      vertices[base] = p.x
      vertices[base + 1] = p.y
      vertices[base + 2] = p.z
      const norm = Math.min(Math.max(p.y, 0), 200) / 200
      const c = new THREE.Color().lerpColors(new THREE.Color(0x000000), new THREE.Color(0xffffff), norm)
      colors[base] = c.r
      colors[base + 1] = c.g
      colors[base + 2] = c.b
    })

    const lenA = iArr.length
    const lenB = oArr.length
    if (lenA < 2 || lenB < 2) {
      console.warn('One ring has <2 points; skipping band creation.')
      return this.makeEmptyGeometry()
    }

    let i = 0
    let j = 0
    let steps = 0
    const maxSteps = lenA + lenB + 20

    while (steps < maxSteps) {
      const iNext = (i + 1) % lenA
      const jNext = (j + 1) % lenB

      const a = i
      const b = offsetOuter + j
      const aNext = iNext
      const bNext = offsetOuter + jNext

      if (this.shouldBuildTriangles(iArr, oArr, a, b - offsetOuter, aNext, jNext)) {
        indices.push(a, b, aNext)
        indices.push(aNext, b, offsetOuter + jNext)
      }

      const angleA = Math.atan2(iArr[a].z, iArr[a].x)
      const angleB = Math.atan2(oArr[j].z, oArr[j].x)
      if (angleA <= angleB) {
        i = iNext
      } else {
        j = jNext
      }
      steps++
      if (i === 0 && j === 0 && steps > 1) break
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      metalness: 0.2,
      roughness: 0.7
    })
    const wireMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      wireframe: true,
      transparent: true,
      opacity: 0.4
    })

    return { geometry, material, wireMaterial }
  }

  shouldBuildTriangles(iArr, oArr, a, b, aNext, bNext) {
    const A = iArr[a]
    const B = oArr[b]
    const C = iArr[aNext]
    const D = oArr[bNext]
    if (!A || !B || !C || !D) return false

    if (!this.isTriangleSizeOk(A, B, C) || !this.isTriangleSizeOk(C, B, D)) return false
    if (!this.isTriangleAreaOk(A, B, C) || !this.isTriangleAreaOk(C, B, D)) return false

    if (this.overshadowCheck) {
      if (this.triangleOvershadowsPoints(A, B, C)) return false
      if (this.triangleOvershadowsPoints(C, B, D)) return false
    }
    return true
  }

  isTriangleSizeOk(A, B, C) {
    const dAB = this.dist3D(A, B)
    const dBC = this.dist3D(B, C)
    const dCA = this.dist3D(C, A)
    if (dAB > this.maxEdgeMeters || dBC > this.maxEdgeMeters || dCA > this.maxEdgeMeters) {
      return false
    }
    return true
  }

  isTriangleAreaOk(A, B, C) {
    const area = this.triangleArea2D(A.x, A.z, B.x, B.z, C.x, C.z)
    return area <= this.maxTriangleArea
  }

  dist3D(p1, p2) {
    const dx = p1.x - p2.x
    const dy = p1.y - p2.y
    const dz = p1.z - p2.z
    return Math.sqrt(dx*dx + dy*dy + dz*dz)
  }

  triangleArea2D(ax, az, bx, bz, cx, cz) {
    const area = Math.abs(
      ax * (bz - cz) +
      bx * (cz - az) +
      cx * (az - bz)
    ) / 2
    return area
  }

  triangleOvershadowsPoints(A, B, C) {
    for (const pt of this.savedPoints) {
      const x = Utils.mapLongitudeToX(pt.longitude, this.centerLongitude, this.scaleMultiplier)
      const z = Utils.mapLatitudeToZ(pt.latitude, this.centerLatitude, this.scaleMultiplier)
      const y = pt.elevation * this.scaleMultiplier

      if (this.pointInTriangle2D(x, z, A.x, A.z, B.x, B.z, C.x, C.z)) {
        const minY = Math.min(A.y, B.y, C.y)
        if (y < minY) return true
      }
    }
    return false
  }

  pointInTriangle2D(px, pz, ax, az, bx, bz, cx, cz) {
    const areaABC = this.triangleArea2D(ax, az, bx, bz, cx, cz)
    const areaPAB = this.triangleArea2D(px, pz, ax, az, bx, bz)
    const areaPBC = this.triangleArea2D(px, pz, bx, bz, cx, cz)
    const areaPCA = this.triangleArea2D(px, pz, cx, cz, ax, az)
    const sum = areaPAB + areaPBC + areaPCA
    const epsilon = 1e-5
    return Math.abs(sum - areaABC) < epsilon
  }

  makeEmptyGeometry() {
    const geometry = new THREE.BufferGeometry()
    const material = new THREE.MeshBasicMaterial({ color: 0x999999 })
    const wireMaterial = new THREE.MeshBasicMaterial({ wireframe: true })
    return { geometry, material, wireMaterial }
  }

  // -----------------------------------------------
  // Elevation + Raycast
  // -----------------------------------------------
  async fetchRingElevation(ringLatLon) {
    const ringData = []
    let index = 0

    const fetchWithRetry = async (longitude, latitude, attempt = 1) => {
      const elev = await this.fetchElevation(longitude, latitude)
      if ((elev === null || isNaN(elev)) && attempt <= this.fetchRetries) {
        const delay = Math.pow(2, attempt) * 100
        console.warn(
          `Retry ring fetch for (${latitude.toFixed(5)},${longitude.toFixed(5)}) - Attempt ${
            attempt + 1
          } after ${delay}ms`
        )
        await new Promise(r => setTimeout(r, delay))
        return fetchWithRetry(longitude, latitude, attempt + 1)
      }
      return elev
    }

    const worker = async () => {
      while (true) {
        const i = index++
        if (i >= ringLatLon.length) break
        const p = ringLatLon[i]
        const e = await fetchWithRetry(p.longitude, p.latitude)
        ringData[i] = {
          latitude: p.latitude,
          longitude: p.longitude,
          elevation: e || 0
        }

        requestAnimationFrame(() => {
          this.addPointsToPointCloud([ringData[i]])
        })
      }
    }

    const tasks = []
    for (let i = 0; i < this.fetchConcurrency; i++) tasks.push(worker())
    await Promise.all(tasks)

    return ringData
  }

  async fetchElevation(lon, lat) {
    const url = `${this.elevationAPI}?x=${lon}&y=${lat}&units=Meters&output=json`
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        throw new Error(`Elevation fetch error: ${resp.statusText}`)
      }
      const text = await resp.text()
      console.log(`Elevation @ (${lat},${lon}):`, text)
      const data = JSON.parse(text)
      if (data && data.value !== undefined) {
        return data.value
      }
    } catch (err) {
      console.error(`Fail elev fetch for (${lat},${lon}):`, err)
    }
    return null
  }

  /**
   * findClosestGridPoint will also check if the user is near the outer ring edge
   * and automatically expand the terrain by building ring (currentMaxRing+1)
   * if needed.
   */
  findClosestGridPoint(x, z) {
    // 1) Possibly expand ring if user is near the outer edge
    const distFromCenter = Math.hypot(x, z)
    const outerRingRadius = this.currentMaxRing * this.gridCellSizeMeters

    // If user is near e.g. 80% of outer ring => build next ring
    if (distFromCenter > 0.8 * outerRingRadius) {
      const nextRing = this.currentMaxRing + 1
      console.log(`Expanding ring from findClosestGridPoint => building ring ${nextRing}`)
      this.buildRing(nextRing) // asynchronous
        .then(() => {
          this.currentMaxRing = nextRing
        })
        .catch(err => console.error('Error building new ring in findClosestGridPoint:', err))
    }

    // 2) Then do normal "find closest point" logic among savedPoints
    let closest = null
    let minDistSq = Infinity
    for (const pt of this.savedPoints) {
      const px = Utils.mapLongitudeToX(pt.longitude, this.centerLongitude, this.scaleMultiplier)
      const pz = Utils.mapLatitudeToZ(pt.latitude, this.centerLatitude, this.scaleMultiplier)
      const dSq = Utils.calculateDistanceSq(x, z, px, pz)
      if (dSq < minDistSq) {
        minDistSq = dSq
        closest = pt
      }
    }
    return closest
  }

  getTerrainHeightAtPoint(x, z) {
    const p = this.findClosestGridPoint(x, z)
    if (!p) return 0
    const e = parseFloat(p.elevation)
    return isNaN(e) ? 0 : e
  }

  getTerrainHeightAt(x, z) {
    if (!this.sceneChunks || !this.sceneChunks.length) return 0

    const rayOrigin = new THREE.Vector3(x, 999999, z)
    const rayDir = new THREE.Vector3(0, -1, 0)
    const raycaster = new THREE.Raycaster(rayOrigin, rayDir)

    let maxY = 0
    this.sceneChunks.forEach(mesh => {
      const hits = raycaster.intersectObject(mesh)
      if (hits && hits.length > 0) {
        const yHit = hits[0].point.y
        if (yHit > maxY) {
          maxY = yHit
        }
      }
    })
    return maxY
  }
}


// ------------------------------
// VRControllers Class
// ------------------------------
class VRControllers {
  constructor (
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

  initControllers () {
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

  onSelectStart (event, index) {
    this.controllerData[index].isSelecting = true
  }

  onSelectEnd (event, index) {
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
  update () {
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
  setTeleportableObjects (meshes) {
    this.teleportableObjects = meshes || []
  }
}

// ------------------------------
// Multiplayer Class
// ------------------------------
class Multiplayer {
  constructor (socket, scene, terrain) {
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
  initializePlayerID () {
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
  initSocketEvents () {
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
  addOrUpdatePlayer (id, data) {
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
  createRemotePlayer (id, data) {
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
  updateRemotePlayer (id, data) {
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
  removeRemotePlayer (id) {
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
  updatePlayers (playersData) {
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
  addRemoteAudioStream (id) {
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

  removeRemoteAudioStream (id) {
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

  receiveAudioStream (id, audioBuffer) {
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
  constructor (app) {
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

  initKeyboardEvents () {
    console.log('Initializing keyboard events for movement.')
    document.addEventListener('keydown', this.onKeyDown.bind(this))
    document.addEventListener('keyup', this.onKeyUp.bind(this))
  }

  onKeyDown (e) {
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

  onKeyUp (e) {
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

  handleKeyStates () {
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
  moveCharacter (delta) {
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
  constructor () {
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
  initPaths () {
    console.log(`Model Path: ${CONFIG.modelPath}`)
    console.log(`Font Path: ${CONFIG.fontPath}`)
  }

  /**
   * Injects custom font into the document.
   */
  injectFont () {
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
  initScene () {
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
  initPostProcessing () {
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
  setupVRControllers () {
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
  handleTeleport (point) {
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
  initSensors () {
    window.addEventListener('appPermissionsChanged', () => {
      // Possibly reload CONFIG from localStorage if you like:
      // const newConfig = loadConfig();
      // Then pass updated permissions to Sensors:
      Sensors.initialize(CONFIG.permissions)
    })
  }

  /**
   * Initializes the day-night cycle.
   */
  initDayNightCycle () {
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
  initTerrain () {
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
  initSocketEvents () {
    console.warn('[Socket] Connected to server.')
    this.multiplayer = new Multiplayer(this.socket, this.scene, this.terrain)
  }

  /**
   * Binds UI-related events.
   */
  bindUIEvents () {
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
  handleUserInteraction () {
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
  async encryptAndEmitLatLon () {
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
  savePositionToLocalStorage () {
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
  loadPositionFromLocalStorage () {
    return Storage.load(CONFIG.localStorageKeys.lastPosition)
  }

  /**
   * Normalizes an angle to the range [-π, π].
   * @param {number} angle - The angle in radians.
   * @returns {number} - The normalized angle.
   */
  normalizeAngle (angle) {
    return Utils.normalizeAngle(angle)
  }

  /**
   * Retrieves the camera's yaw rotation.
   * @returns {number} - The yaw angle in radians.
   */
  getCameraYaw () {
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
  emitMovementIfChanged (newState) {
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
  reportPosition () {
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
  
    // 10. Create Euler angles with the order 'YXZ' to handle rotations properly
    const euler = new THREE.Euler(pitchRad, adjustedYawRad, rollRad, 'YXZ');
  
    // 11. Create device quaternion from Euler angles
    const deviceQuaternion = new THREE.Quaternion().setFromEuler(euler);
  
    // 12. Reference Quaternion: Rotate -90 degrees around Z-axis to align device frame with Three.js frame
    const referenceQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, -Math.PI / 2, 'YXZ') // -90 degrees around Z-axis
    );
  
    // 13. Combine Reference Quaternion with Device Quaternion
    // Quaternion multiplication order is important: reference * device
    const finalQuaternion = referenceQuaternion.clone().multiply(deviceQuaternion);
  
    // 14. Normalize the final quaternion to prevent errors over time
    finalQuaternion.normalize();
  
    // 15. Apply the final quaternion to the camera
    this.camera.quaternion.copy(finalQuaternion);
  
    // 16. Optional: Log final quaternion for debugging
    console.log(
      `Final Quaternion: x=${finalQuaternion.x.toFixed(4)}, y=${finalQuaternion.y.toFixed(4)}, z=${finalQuaternion.z.toFixed(4)}, w=${finalQuaternion.w.toFixed(4)}`
    );
  }
  

  /**
   * Handles window resize events.
   */
  onWindowResize () {
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
  setLocalAction (action) {
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
  loadLocalModel () {
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

  isTouchDevice() {
    return (('ontouchstart' in window) ||
       (navigator.maxTouchPoints > 0) ||
       (navigator.msMaxTouchPoints > 0));
  }
  

  /**
   * Initializes the render loop.
   */
  animate () {
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

      UI.updateField('Orientation_a', Sensors.orientationData.alpha);
      UI.updateField('Orientation_b', Sensors.orientationData.beta);
      UI.updateField('Orientation_g', Sensors.orientationData.gamma);

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

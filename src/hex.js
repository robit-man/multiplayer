// Ensure that Three.js is included in your HTML via a script tag:
// <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
// <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/examples/js/controls/OrbitControls.js"></script>
import * as THREE from 'three'

(() => {
    // ===========================
    // 1. Three.js Scene Setup
    // ===========================
  
    // Create the scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb); // Sky blue background
  
    // Create the camera
    const camera = new THREE.PerspectiveCamera(
      75, // Field of view
      window.innerWidth / window.innerHeight, // Aspect ratio
      0.1, // Near clipping plane
      10000 // Far clipping plane
    );
    camera.position.set(0, 500, 1000); // Positioned to view the terrain
  
    // Create the renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true; // Enable shadow mapping
    document.body.appendChild(renderer.domElement);
  
    // Add orbit controls for interactive navigation
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.update();
  
    // Add ambient light for basic illumination
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
  
    // Add directional light for shadows and depth
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(1000, 1000, 1000);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.left = -1000;
    directionalLight.shadow.camera.right = 1000;
    directionalLight.shadow.camera.top = 1000;
    directionalLight.shadow.camera.bottom = -1000;
    scene.add(directionalLight);
  
    // ===========================
    // 2. Global Variables and Constants
    // ===========================
  
    // Terrain Configuration
    const gridSizeMeters = 500; // Total size of the grid in meters
    const gridResolution = 100; // Number of rings (resolution)
  
    // Scaling Factors
    let scaleMultiplier = 1; // Terrain height scaling
  
    // Reference Elevation for Normalization
    let referenceElevation = 0; // Will be set based on initial location
  
    // Origin Coordinates (Geographic)
    let originLatitude = null;
    let originLongitude = null;
  
    // Axial Coordinates Grid (q, r)
    const sortedGrid = {}; // Key: 'q,r', Value: point object
  
    // Elevation Data Storage
    window.elevationData = [];
  
    // Local Storage Key
    const LS_TERRAIN_POINTS_KEY = 'terrainPoints';
  
    // Terrain Mesh Objects
    let terrainMesh = null; // Solid mesh
    let terrainMeshWire = null; // Wireframe mesh
  
    // Render Control
    const POINTS_BATCH_SIZE = 100; // Points rendered per frame
    let nextPointIndex = 0; // Next point to render
    const totalPoints = gridResolution * (gridResolution + 1); // Total points based on hex grid
  
    // Flags
    let terrainInitialized = false;
  
    // Line Drawing Generator
    let lineDrawingGenerator = null;
  
    // ===========================
    // 3. Utility Functions
    // ===========================
  
    /**
     * Updates a UI field with the given value.
     * @param {string} fieldId - The ID of the UI element to update.
     * @param {string} value - The value to set.
     */
    function updateField(fieldId, value) {
      const field = document.getElementById(fieldId);
      if (field) {
        field.textContent = value;
      }
    }
  
    /**
     * Calculates the distance between two geographic points using the Haversine formula.
     * @param {number} lat1 - Latitude of point 1 in degrees.
     * @param {number} lon1 - Longitude of point 1 in degrees.
     * @param {number} lat2 - Latitude of point 2 in degrees.
     * @param {number} lon2 - Longitude of point 2 in degrees.
     * @returns {number} Distance in meters.
     */
    function calculateDistance(lat1, lon1, lat2, lon2) {
      const R = 6371000; // Earth's radius in meters
      const dLat = THREE.MathUtils.degToRad(lat2 - lat1);
      const dLon = THREE.MathUtils.degToRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(THREE.MathUtils.degToRad(lat1)) *
          Math.cos(THREE.MathUtils.degToRad(lat2)) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }
  
    // ===========================
    // 4. Grid Generation and Management
    // ===========================
  
    /**
     * Converts axial coordinates to geographic offsets.
     * @param {number} q - Axial q-coordinate.
     * @param {number} r - Axial r-coordinate.
     * @returns {Object} Object with latitude and longitude.
     */
    function axialToGeo(q, r) {
      const hexSize = gridSizeMeters / gridResolution; // Size of each hexagon
      const x = hexSize * Math.sqrt(3) * (q + r / 2);
      const z = hexSize * (3 / 2) * r;
  
      // Convert meters to degrees
      const metersPerDegLat = 111320; // Approximate meters per degree latitude
      const metersPerDegLon =
        111320 * Math.cos(THREE.MathUtils.degToRad(originLatitude));
  
      const deltaLat = z / metersPerDegLat;
      const deltaLon = x / metersPerDegLon;
  
      return {
        latitude: originLatitude + deltaLat,
        longitude: originLongitude + deltaLon,
      };
    }
  
    /**
     * Generates a hexagonal spiral grid of geographic points centered at (0, 0, 0) in the scene.
     * Ensures exactly gridResolution^2 points are generated.
     * @param {Object} center - Object with latitude and longitude.
     * @param {number} gridSizeMeters - Size of the grid in meters.
     * @param {number} gridResolution - Number of rings in the grid.
     * @returns {Array} Array of point objects with latitude and longitude.
     */
    function generateGrid(center, gridSizeMeters, gridResolution) {
      const points = [];
      const hexSize = gridSizeMeters / gridResolution; // Size of each hexagon
  
      // Start with the center point
      points.push({ q: 0, r: 0, ...axialToGeo(0, 0), elevation: referenceElevation });
  
      // Generate points ring by ring outward from the center
      for (let ring = 1; ring <= gridResolution; ring++) {
        let q = ring;
        let r = 0;
  
        // Traverse each of the six directions
        for (let side = 0; side < 6; side++) {
          for (let step = 0; step < ring; step++) {
            points.push({
              q: q,
              r: r,
              ...axialToGeo(q, r),
              elevation: referenceElevation, // Placeholder, will be updated with fetched data
            });
  
            // Move to the next hex in the current direction
            switch (side) {
              case 0:
                q -= 1;
                r += 1;
                break; // Up-left
              case 1:
                r += 1;
                break; // Up-right
              case 2:
                q += 1;
                r -= 1;
                break; // Down-right
              case 3:
                q += 1;
                break; // Down-left
              case 4:
                r -= 1;
                break; // Left
              case 5:
                q -= 1;
                r -= 1;
                break; // Right
              default:
                break;
            }
          }
        }
      }
  
      // Trim or pad the points array to match totalPoints
      if (points.length > totalPoints) {
        return points.slice(0, totalPoints);
      } else {
        // If fewer points, pad with existing points (e.g., center)
        while (points.length < totalPoints) {
          points.push({ ...axialToGeo(0, 0), elevation: referenceElevation });
        }
        return points;
      }
    }
  
    /**
     * Generates a missing point by interpolating elevation from neighboring points.
     * @param {number} q - Axial q-coordinate in the grid.
     * @param {number} r - Axial r-coordinate in the grid.
     * @returns {Object|null} Generated point object or null if unable to generate.
     */
    function generateMissingPoint(q, r) {
      const neighbors = [];
  
      // Define neighbor offsets for a hexagonal grid (6 neighbors)
      const neighborOffsets = [
        { q: 1, r: 0 }, // Right
        { q: 0, r: 1 }, // Top-right
        { q: -1, r: 1 }, // Top-left
        { q: -1, r: 0 }, // Left
        { q: 0, r: -1 }, // Bottom-left
        { q: 1, r: -1 }, // Bottom-right
      ];
  
      neighbors.push(
        ...neighborOffsets
          .map((offset) => {
            const neighborQ = q + offset.q;
            const neighborR = r + offset.r;
            const key = `${neighborQ},${neighborR}`;
            const neighborPoint = sortedGrid[key];
            if (neighborPoint && neighborPoint.elevation !== undefined) {
              return neighborPoint.elevation;
            }
            return null;
          })
          .filter((elevation) => elevation !== null)
      );
  
      if (neighbors.length === 0) {
        return null; // Unable to generate without neighbors
      }
  
      // Calculate average elevation from neighbors
      const sum = neighbors.reduce((acc, val) => acc + val, 0);
      const averageElevation = sum / neighbors.length;
  
      // Calculate geographic coordinates based on axial positions
      const geoPoint = axialToGeo(q, r);
  
      return {
        q: q,
        r: r,
        latitude: geoPoint.latitude,
        longitude: geoPoint.longitude,
        elevation: averageElevation,
      };
    }
  
    /**
     * Adds a new hexagonal ring to the terrain grid in all directions.
     * @param {number} currentRing - The current number of rings in the grid.
     */
    async function addNewRing(currentRing) {
      const newRingPoints = [];
      const ring = currentRing + 1;
      const hexSize = gridSizeMeters / gridResolution;
  
      let q = ring;
      let r = 0;
  
      // Traverse each of the six directions
      for (let side = 0; side < 6; side++) {
        for (let step = 0; step < ring; step++) {
          // Add the new point
          newRingPoints.push({ q: q, r: r, ...axialToGeo(q, r), elevation: referenceElevation });
  
          // Move to the next hex in the current direction
          switch (side) {
            case 0:
              q -= 1;
              r += 1;
              break; // Up-left
            case 1:
              r += 1;
              break; // Up-right
            case 2:
              q += 1;
              r -= 1;
              break; // Down-right
            case 3:
              q += 1;
              break; // Down-left
            case 4:
              r -= 1;
              break; // Left
            case 5:
              q -= 1;
              r -= 1;
              break; // Right
            default:
              break;
          }
        }
      }
  
      // Fetch elevation data for the new ring
      await fetchElevationGrid(newRingPoints, 'Meters', 10, 3);
  
      // Integrate new points into the sortedGrid
      newRingPoints.forEach((point) => {
        const key = `${point.q},${point.r}`;
        sortedGrid[key] = point;
      });
  
      // Update the mesh after adding new points
      const allSavedPoints = Object.values(sortedGrid);
      createTerrainMesh(allSavedPoints);
    }
  
    // ===========================
    // 5. Elevation Data Handling
    // ===========================
  
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
          return parseFloat(data.value); // Ensure elevation is a number
        } else {
          throw new Error('Invalid elevation data received.');
        }
      } catch (error) {
        console.error(
          `Failed to fetch elevation for (${latitude.toFixed(
            5
          )}, ${longitude.toFixed(5)}):`,
          error
        );
        return null; // Indicate failure
      }
    }
  
    /**
     * Fetches elevation data for a grid of geographic points.
     * Limits the number of concurrent fetches and implements retry logic.
     * @param {Array} points - Array of points with q, r, latitude, and longitude.
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
          console.warn(
            `Retrying elevation fetch for (${latitude.toFixed(
              5
            )}, ${longitude.toFixed(5)}) - Attempt ${attempt + 1}`
          );
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
              q: point.q,
              r: point.r,
              latitude: point.latitude,
              longitude: point.longitude,
              elevation: elevation,
            };
            window.elevationData.push(elevationPoint);
            sortedGrid[`${point.q},${point.r}`].elevation = elevation;
            console.log(
              `Lat: ${elevationPoint.latitude.toFixed(
                5
              )}, Lon: ${elevationPoint.longitude.toFixed(
                5
              )}, Elevation: ${elevationPoint.elevation} meters`
            );
          } else {
            console.log(
              `Lat: ${point.latitude.toFixed(5)}, Lon: ${point.longitude.toFixed(
                5
              )}, Elevation: Fetch Failed`
            );
            // Attempt to generate missing point
            const generatedPoint = generateMissingPoint(point.q, point.r);
            if (generatedPoint) {
              sortedGrid[`${point.q},${point.r}`].elevation = generatedPoint.elevation;
              window.elevationData.push(generatedPoint);
              console.log(
                `Generated elevation for (${generatedPoint.latitude.toFixed(
                  5
                )}, ${generatedPoint.longitude.toFixed(5)}): ${generatedPoint.elevation} meters`
              );
            }
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
  
      console.log('All elevation data fetched.');
    }
  
    // ===========================
    // 6. Local Storage Handling
    // ===========================
  
    /**
     * Saves a batch of points to localStorage.
     * Ensures that the total saved points do not exceed totalPoints.
     * @param {Array} pointsBatch - Array of point objects to save.
     */
    function savePointsToLocalStorage(pointsBatch) {
      let savedPoints =
        JSON.parse(localStorage.getItem(LS_TERRAIN_POINTS_KEY)) || [];
  
      // Calculate available space
      const availableSpace = totalPoints - savedPoints.length;
      if (availableSpace <= 0) {
        console.warn('LocalStorage is full. Cannot save more terrain points.');
        return;
      }
  
      // Limit pointsBatch to availableSpace
      const pointsToSave = pointsBatch.slice(0, availableSpace);
      if (pointsBatch.length > pointsToSave.length) {
        console.warn(
          `Only ${pointsToSave.length} out of ${pointsBatch.length} points were saved to localStorage to prevent overflow.`
        );
      }
  
      // Merge sortedGrid into savedPoints
      pointsToSave.forEach((point) => {
        savedPoints.push({
          q: point.q,
          r: point.r,
          latitude: point.latitude,
          longitude: point.longitude,
          elevation: point.elevation,
        });
      });
  
      try {
        localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(savedPoints));
        console.log(`Saved ${pointsToSave.length} points to localStorage.`);
      } catch (e) {
        console.error('Failed to save terrain points to localStorage:', e);
      }
    }
  
    /**
     * Loads saved points from localStorage.
     * @returns {Array} Array of saved point objects.
     */
    function loadPointsFromLocalStorage() {
      let savedPoints = JSON.parse(localStorage.getItem(LS_TERRAIN_POINTS_KEY)) || [];
  
      if (savedPoints.length > totalPoints) {
        console.warn(
          `LocalStorage has ${savedPoints.length} points, which exceeds the expected ${totalPoints}. Truncating excess points.`
        );
        savedPoints = savedPoints.slice(0, totalPoints);
        localStorage.setItem(LS_TERRAIN_POINTS_KEY, JSON.stringify(savedPoints));
      }
  
      // Reconstruct sortedGrid
      savedPoints.forEach((point) => {
        const key = `${point.q},${point.r}`;
        sortedGrid[key] = point;
      });
  
      return savedPoints;
    }
  
    // ===========================
    // 7. Terrain Rendering
    // ===========================
  
    /**
     * Initializes the Three.js terrain point cloud with origin at (0, 0, 0).
     */
    function initializeTerrainPointCloud() {
      const positions = new Float32Array(totalPoints * 3); // x, y, z for each point
      const colors = new Float32Array(totalPoints * 3); // r, g, b for each point
  
      const terrainGeometry = new THREE.BufferGeometry();
      terrainGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(positions, 3)
      );
      terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  
      const terrainMaterial = new THREE.PointsMaterial({
        size: 5,
        vertexColors: true,
        transparent: false,
        opacity: 1,
      });
  
      const terrainPointCloud = new THREE.Points(terrainGeometry, terrainMaterial);
      terrainPointCloud.castShadow = false;
      terrainPointCloud.receiveShadow = true;
      scene.add(terrainPointCloud);
    }
  
    /**
     * Populates the terrain point cloud from saved points.
     * Ensures that only up to totalPoints are processed.
     * @param {Array} savedPoints - Array of saved point objects.
     */
    function populateTerrainFromSavedPoints(savedPoints) {
      const terrainPointCloud = scene.children.find(
        (child) => child.type === 'Points'
      );
      if (!terrainPointCloud) {
        console.error('Terrain point cloud not initialized.');
        return;
      }
  
      const positions = terrainPointCloud.geometry.attributes.position.array;
      const colors = terrainPointCloud.geometry.attributes.color.array;
      const metersPerDegLat = 111320;
      const metersPerDegLon =
        111320 * Math.cos(THREE.MathUtils.degToRad(originLatitude));
  
      const pointsToPopulate = savedPoints.slice(0, totalPoints); // Ensure no excess points
  
      pointsToPopulate.forEach((point, index) => {
        const baseIndex = index * 3;
        positions[baseIndex] =
          (point.longitude - originLongitude) * metersPerDegLon;
        positions[baseIndex + 1] =
          (point.elevation - referenceElevation) * scaleMultiplier;
        positions[baseIndex + 2] =
          (point.latitude - originLatitude) * metersPerDegLat;
  
        const normalizedElevation =
          Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80;
        const color = new THREE.Color().lerpColors(
          new THREE.Color(0x0000ff), // Blue for low elevation
          new THREE.Color(0xff0000), // Red for high elevation
          normalizedElevation
        );
  
        colors[baseIndex] = color.r;
        colors[baseIndex + 1] = color.g;
        colors[baseIndex + 2] = color.b;
      });
  
      terrainPointCloud.geometry.attributes.position.needsUpdate = true;
      terrainPointCloud.geometry.attributes.color.needsUpdate = true;
  
      console.log(`Populated terrain with ${pointsToPopulate.length} saved points.`);
    }
  
    /**
     * Renders new terrain points into the scene.
     * Ensures that no more than totalPoints are rendered.
     */
    function renderTerrainPoints() {
      const terrainPointCloud = scene.children.find(
        (child) => child.type === 'Points'
      );
      if (!terrainPointCloud || window.elevationData.length === 0) return;
  
      const positions = terrainPointCloud.geometry.attributes.position.array;
      const colors = terrainPointCloud.geometry.attributes.color.array;
  
      const pointsToAdd = Math.min(
        POINTS_BATCH_SIZE,
        window.elevationData.length,
        totalPoints - nextPointIndex
      );
  
      if (pointsToAdd <= 0) {
        // Once all points are rendered, draw lines and create mesh
        const allSavedPoints = loadPointsFromLocalStorage();
        drawTerrainLinesAsync(allSavedPoints); // Use asynchronous line drawing
        createTerrainMesh(allSavedPoints);
        return;
      }
  
      const pointsBatch = [];
      for (let i = 0; i < pointsToAdd; i++) {
        const point = window.elevationData.shift();
        if (!point) continue;
  
        const baseIndex = nextPointIndex * 3;
  
        positions[baseIndex] =
          (point.longitude - originLongitude) * 111320 * Math.cos(THREE.MathUtils.degToRad(originLatitude));
        positions[baseIndex + 1] =
          (point.elevation - referenceElevation) * scaleMultiplier;
        positions[baseIndex + 2] =
          (point.latitude - originLatitude) * 111320;
  
        const normalizedElevation =
          Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80;
        const color = new THREE.Color().lerpColors(
          new THREE.Color(0x0000ff), // Blue for low elevation
          new THREE.Color(0xff0000), // Red for high elevation
          normalizedElevation
        );
  
        colors[baseIndex] = color.r;
        colors[baseIndex + 1] = color.g;
        colors[baseIndex + 2] = color.b;
  
        pointsBatch.push(point);
        nextPointIndex++;
  
        // Prevent exceeding totalPoints
        if (nextPointIndex >= totalPoints) {
          break;
        }
      }
  
      terrainPointCloud.geometry.attributes.position.needsUpdate = true;
      terrainPointCloud.geometry.attributes.color.needsUpdate = true;
  
      savePointsToLocalStorage(pointsBatch);
  
      console.log(`Rendered ${nextPointIndex} / ${totalPoints} points.`);
      const progress = `Rendered ${nextPointIndex} / ${totalPoints} points.`;
      updateField('progress', progress);
  
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
     * Creates the terrain mesh from saved points.
     * Ensures that the number of points matches the grid's expectation.
     * Origin is set to (0, 0, 0) in the scene.
     * @param {Array} savedPoints - Array of saved point objects.
     */
    function createTerrainMesh(savedPoints) {
      // Define meters per degree based on a fixed latitude for simplicity
      const metersPerDegLat = 111320 * scaleMultiplier;
      const metersPerDegLon =
        111320 * Math.cos(THREE.MathUtils.degToRad(originLatitude)) *
        scaleMultiplier;
  
      // Function to calculate squared distance between two points (X and Z axes only)
      const calculateDistanceSq = (x1, z1, x2, z2) => {
        const dx = x1 - x2;
        const dz = z1 - z2;
        return dx * dx + dz * dz;
      };
  
      // Step 1: Populate Vertices and Colors
      const vertices = [];
      const colors = [];
  
      savedPoints.forEach((point) => {
        const x = (point.longitude - originLongitude) * metersPerDegLon;
        const y = (point.elevation - referenceElevation) * scaleMultiplier;
        const z = (point.latitude - originLatitude) * metersPerDegLat;
  
        vertices.push(x, y, z);
  
        const normalizedElevation =
          Math.min(Math.max(point.elevation - referenceElevation, 0), 80) / 80;
        const color = new THREE.Color().lerpColors(
          new THREE.Color(0x0000ff), // Blue for low elevation
          new THREE.Color(0xff0000), // Red for high elevation
          normalizedElevation
        );
  
        colors.push(color.r, color.g, color.b);
      });
  
      // Step 2: Generate Indices for Triangles Based on Hexagonal Neighbors
      const indices = [];
      const maxTriangleSize = 400; // Adjust based on grid density
      const maxTriangleSizeSq = maxTriangleSize * maxTriangleSize; // Squared distance for efficiency
  
      // Define axial neighbor offsets
      const axialNeighborOffsets = [
        { q: 1, r: 0 }, // Right
        { q: 0, r: 1 }, // Top-right
        { q: -1, r: 1 }, // Top-left
        { q: -1, r: 0 }, // Left
        { q: 0, r: -1 }, // Bottom-left
        { q: 1, r: -1 }, // Bottom-right
      ];
  
      // Iterate through each point to create triangles
      savedPoints.forEach((point) => {
        const currentKey = `${point.q},${point.r}`;
        axialNeighborOffsets.forEach((offset) => {
          const neighborQ = point.q + offset.q;
          const neighborR = point.r + offset.r;
          const neighborKey = `${neighborQ},${neighborR}`;
          const neighborPoint = sortedGrid[neighborKey];
          if (neighborPoint) {
            const currentIndex = savedPoints.findIndex(
              (p) => p.q === point.q && p.r === point.r
            );
            const neighborIndex = savedPoints.findIndex(
              (p) => p.q === neighborQ && p.r === neighborR
            );
  
            if (neighborIndex > currentIndex) {
              const distanceSq = calculateDistanceSq(
                vertices[currentIndex * 3],
                vertices[currentIndex * 3 + 2],
                vertices[neighborIndex * 3],
                vertices[neighborIndex * 3 + 2]
              );
  
              if (distanceSq <= maxTriangleSizeSq) {
                // Find the next neighbor in clockwise direction
                const currentOffsetIndex = axialNeighborOffsets.findIndex(
                  (o) => o.q === offset.q && o.r === offset.r
                );
                const nextOffsetIndex =
                  (currentOffsetIndex + 1) % axialNeighborOffsets.length;
                const nextOffset = axialNeighborOffsets[nextOffsetIndex];
                const nextNeighborQ = point.q + nextOffset.q;
                const nextNeighborR = point.r + nextOffset.r;
                const nextNeighborKey = `${nextNeighborQ},${nextNeighborR}`;
                const nextNeighborPoint = sortedGrid[nextNeighborKey];
  
                if (nextNeighborPoint) {
                  const nextNeighborIndex = savedPoints.findIndex(
                    (p) => p.q === nextNeighborQ && p.r === nextNeighborR
                  );
                  const distanceToNextSq = calculateDistanceSq(
                    vertices[neighborIndex * 3],
                    vertices[neighborIndex * 3 + 2],
                    vertices[nextNeighborIndex * 3],
                    vertices[nextNeighborIndex * 3 + 2]
                  );
  
                  if (distanceToNextSq <= maxTriangleSizeSq) {
                    indices.push(currentIndex, neighborIndex, nextNeighborIndex);
                  }
                }
  
                // Similarly, find the previous neighbor in counter-clockwise direction
                const prevOffsetIndex =
                  (currentOffsetIndex - 1 + axialNeighborOffsets.length) %
                  axialNeighborOffsets.length;
                const prevOffset = axialNeighborOffsets[prevOffsetIndex];
                const prevNeighborQ = point.q + prevOffset.q;
                const prevNeighborR = point.r + prevOffset.r;
                const prevNeighborKey = `${prevNeighborQ},${prevNeighborR}`;
                const prevNeighborPoint = sortedGrid[prevNeighborKey];
  
                if (prevNeighborPoint) {
                  const prevNeighborIndex = savedPoints.findIndex(
                    (p) => p.q === prevNeighborQ && p.r === prevNeighborR
                  );
                  const distanceToPrevSq = calculateDistanceSq(
                    vertices[neighborIndex * 3],
                    vertices[neighborIndex * 3 + 2],
                    vertices[prevNeighborIndex * 3],
                    vertices[prevNeighborIndex * 3 + 2]
                  );
  
                  if (distanceToPrevSq <= maxTriangleSizeSq) {
                    indices.push(currentIndex, nextNeighborIndex, neighborIndex);
                  }
                }
              }
            }
          }
        });
      });
  
      // Step 3: Assign Attributes to Geometry
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
  
      // Step 4: Create Material with Vertex Colors, Shading, and Reflectivity
      const materialWire = new THREE.MeshStandardMaterial({
        vertexColors: true, // Enable vertex colors
        wireframe: true, // Wireframe for visual clarity
        transparent: true, // Enable transparency
        opacity: 0.2, // Set opacity level
        metalness: 0.7, // Slight reflectivity (range: 0.0 - 1.0)
        roughness: 0.2, // Moderate roughness for shading (range: 0.0 - 1.0)
      });
  
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true, // Enable vertex colors
        wireframe: false, // Solid mesh
        transparent: true, // Enable transparency
        side: THREE.DoubleSide, // Render both sides
        opacity: 0.95, // Full opacity
        metalness: 0.2, // Higher reflectivity
        roughness: 0.7, // Moderate roughness
      });
  
      // Step 5: Create and Add the Terrain Mesh to the Scene
      terrainMesh = new THREE.Mesh(geometry, material);
      terrainMesh.castShadow = false;
      terrainMesh.receiveShadow = true;
      scene.add(terrainMesh);
  
      // Step 6: Create and Add the Terrain Mesh Wireframe to the Scene
      terrainMeshWire = new THREE.Mesh(geometry, materialWire);
      terrainMeshWire.castShadow = false;
      terrainMeshWire.receiveShadow = false;
      scene.add(terrainMeshWire);
  
      console.log('Terrain mesh created and added to the scene.');
    }
  
    /**
     * Draws terrain lines asynchronously to prevent blocking the main thread.
     * @param {Array} savedPoints - Array of saved point objects.
     */
    function drawTerrainLinesAsync(savedPoints) {
      if (!lineDrawingGenerator) {
        lineDrawingGenerator = terrainLineDrawingGenerator(savedPoints);
      }
  
      const result = lineDrawingGenerator.next();
      if (result.done) {
        lineDrawingGenerator = null; // Reset generator when done
        console.log('Asynchronous terrain lines drawing completed.');
      } else {
        // Continue drawing in the next frame
        requestAnimationFrame(() => drawTerrainLinesAsync(savedPoints));
      }
    }
  
    /**
     * Generator function for drawing terrain lines.
     * Processes the hexagonal grid in chunks to avoid blocking.
     * @param {Array} savedPoints - Array of saved point objects.
     */
    function* terrainLineDrawingGenerator(savedPoints) {
      const linePositions = [];
      const metersPerDegLat = 111320 * scaleMultiplier;
      const metersPerDegLon =
        111320 * Math.cos(THREE.MathUtils.degToRad(originLatitude)) *
        scaleMultiplier;
  
      const gridSize = gridResolution; // Number of rings
      const maxLineDistance = 15; // Maximum distance between connected points in meters
      const maxLineDistanceSq = maxLineDistance * maxLineDistance;
  
      // Define axial neighbor offsets
      const axialNeighborOffsets = [
        { q: 1, r: 0 }, // Right
        { q: 0, r: 1 }, // Top-right
        { q: -1, r: 1 }, // Top-left
        { q: -1, r: 0 }, // Left
        { q: 0, r: -1 }, // Bottom-left
        { q: 1, r: -1 }, // Bottom-right
      ];
  
      // Set to track connected pairs and prevent duplicates
      const connectedPairs = new Set();
  
      savedPoints.forEach((point) => {
        axialNeighborOffsets.forEach((offset) => {
          const neighborQ = point.q + offset.q;
          const neighborR = point.r + offset.r;
          const neighborKey = `${neighborQ},${neighborR}`;
          const neighborPoint = sortedGrid[neighborKey];
          if (neighborPoint) {
            const distanceSq =
              Math.pow(
                (point.longitude - originLongitude) * metersPerDegLon -
                  (neighborPoint.longitude - originLongitude) * metersPerDegLon,
                2
              ) +
              Math.pow(
                (point.latitude - originLatitude) * metersPerDegLat -
                  (neighborPoint.latitude - originLatitude) * metersPerDegLat,
                2
              );
  
            if (distanceSq <= maxLineDistanceSq) {
              const currentIndex = savedPoints.findIndex(
                (p) => p.q === point.q && p.r === point.r
              );
              const neighborIndex = savedPoints.findIndex(
                (p) => p.q === neighborQ && p.r === neighborR
              );
  
              const key =
                currentIndex < neighborIndex
                  ? `${currentIndex}-${neighborIndex}`
                  : `${neighborIndex}-${currentIndex}`;
  
              if (!connectedPairs.has(key)) {
                connectedPairs.add(key);
                linePositions.push(
                  (point.longitude - originLongitude) * metersPerDegLon,
                  (point.elevation - referenceElevation) * scaleMultiplier,
                  (point.latitude - originLatitude) * metersPerDegLat,
                  (neighborPoint.longitude - originLongitude) * metersPerDegLon,
                  (neighborPoint.elevation - referenceElevation) * scaleMultiplier,
                  (neighborPoint.latitude - originLatitude) * metersPerDegLat
                );
              }
            }
          }
        });
      });
  
      // After all lines are collected, create the line segments
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(linePositions, 3)
      );
  
      const lineMaterial = new THREE.LineBasicMaterial({
        color: 0xffffff,
        opacity: 0.5,
        transparent: true,
      });
      const terrainLineSegments = new THREE.LineSegments(lineGeometry, lineMaterial);
      scene.add(terrainLineSegments);
  
      yield; // Final yield to indicate completion
    }
  
    // ===========================
    // 8. Event Handling
    // ===========================
  
    /**
     * Initializes or updates the terrain based on the 'locationUpdated' event.
     */
    window.addEventListener('locationUpdated', async () => {
      const { latitude, longitude } = window;
  
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        console.error(
          'Latitude and Longitude must be set on the window object as numbers.'
        );
        return;
      }
  
      if (!terrainInitialized) {
        console.log(
          `Initializing terrain for Latitude: ${latitude}, Longitude: ${longitude}`
        );
        terrainInitialized = true;
  
        try {
          // Set origin at (0, 0, 0) in the scene
          originLatitude = latitude;
          originLongitude = longitude;
          referenceElevation = 0; // Set based on your requirements
  
          const gridPoints = generateGrid(
            { latitude, longitude },
            gridSizeMeters,
            gridResolution
          );
  
          console.log(`Generated ${gridPoints.length} hexagonal grid points.`);
  
          // Initialize Terrain Point Cloud
          initializeTerrainPointCloud();
  
          // Load saved points from localStorage
          const savedPoints = loadPointsFromLocalStorage();
          if (savedPoints.length > 0) {
            console.log(`Loaded ${savedPoints.length} points from localStorage.`);
            populateTerrainFromSavedPoints(savedPoints);
            nextPointIndex = savedPoints.length;
          }
  
          // Fetch remaining elevation data
          const remainingSpace = totalPoints - savedPoints.length;
          if (remainingSpace > 0) {
            const remainingPoints = gridPoints.slice(
              nextPointIndex,
              nextPointIndex + remainingSpace
            );
            if (remainingPoints.length > 0) {
              await fetchElevationGrid(remainingPoints, 'Meters', 10, 3);
              console.log('Started fetching elevation data for remaining points.');
              // After fetching, render the points
              requestAnimationFrame(renderTerrainPoints);
            }
          } else {
            console.log('All terrain points loaded from localStorage.');
            // Draw lines and create mesh if all points are loaded
            drawTerrainLinesAsync(savedPoints); // Use asynchronous line drawing
            createTerrainMesh(savedPoints);
          }
  
          previousLocation = { latitude, longitude };
        } catch (error) {
          console.error('Error during terrain initialization:', error);
        }
      } else {
        // Terrain has been initialized, check for movement and expand grid if necessary
        const movementThreshold = 10; // Meters; adjust as needed
        const movementDistance = calculateDistance(
          previousLocation.latitude,
          previousLocation.longitude,
          latitude,
          longitude
        );
  
        if (movementDistance >= movementThreshold) {
          // Determine direction of movement
          const deltaLat = latitude - previousLocation.latitude;
          const deltaLon = longitude - previousLocation.longitude;
  
          // Update grid boundaries based on movement
          // For simplicity, add a new ring in all directions
          const currentRing = Math.floor((gridResolution - 1) / 2);
          await addNewRing(currentRing);
  
          previousLocation = { latitude, longitude };
        } else {
          console.log(
            `Movement detected (${movementDistance.toFixed(
              2
            )} meters) is below the threshold (${movementThreshold} meters).`
          );
        }
      }
    });
  
    // ===========================
    // 9. Animation Loop
    // ===========================
  
    function animate() {
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
  
    animate();
  
    // ===========================
    // 10. Initial Trigger (For Testing)
    // ===========================
  
    // Example: Trigger 'locationUpdated' with initial coordinates
    // Replace with actual location data in your application
    window.latitude = 37.7749; // Example latitude (San Francisco)
    window.longitude = -122.4194; // Example longitude (San Francisco)
    window.dispatchEvent(new Event('locationUpdated'));
  
    // ===========================
    // 11. Additional Functions
    // ===========================
  
    // Define previous location for movement detection
    let previousLocation = {
      latitude: null,
      longitude: null,
    };
  })();
  
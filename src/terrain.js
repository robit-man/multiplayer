// terrainInit.js

// Ensure this script runs after Three.js is loaded and the scene is initialized

// Flag to prevent multiple initializations
let terrainInitialized = false;

// Expose elevation data to the window object
window.elevationData = [];

// Terrain Point Cloud Objects
let terrainGeometry = null;
let terrainMaterial = null;
let terrainPointCloud = null;

// Render Control
const POINTS_BATCH_SIZE = 100; // Number of points to render per frame

// Listen for the custom 'locationUpdated' event
window.addEventListener('locationUpdated', async () => {
    if (terrainInitialized) {
        console.log("Terrain has already been initialized.");
        return;
    }

    // Validate that latitude and longitude are available
    const { latitude, longitude } = window;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        console.error("Latitude and Longitude must be set on the window object as numbers.");
        return;
    }

    console.log(`Initializing terrain for Latitude: ${latitude}, Longitude: ${longitude}`);

    // Mark terrain as initialized to prevent multiple initializations
    terrainInitialized = true;

    try {
        // Step 1: Generate 200x200 Grid Points
        const gridSizeMeters = 1000; // 1 km radius
        const gridResolution = 200; // 200 points per side for 200x200 grid
        const gridPoints = generateGrid({ latitude, longitude }, gridSizeMeters, gridResolution);

        console.log(`Generated ${gridPoints.length} grid points.`); // Should be 40,000 points

        // Step 2: Initialize Terrain Point Cloud
        initializeTerrainPointCloud();

        // Step 3: Fetch Elevation Data
        fetchElevationGrid(gridPoints, 'Meters', 10, 3); // Increased concurrency and retries

        console.log('Started fetching elevation data.');

    } catch (error) {
        console.error("Error during terrain initialization:", error);
    }
});

/**
 * Generates a 200x200 grid of geographic points around a center location.
 * @param {Object} center - The center point with latitude and longitude.
 * @param {number} gridSizeMeters - The radius around the center in meters.
 * @param {number} gridResolution - Number of points per side (200 for 200x200 grid).
 * @returns {Array} Array of points with latitude and longitude.
 */
function generateGrid(center, gridSizeMeters = 1000, gridResolution = 200) {
    const points = [];
    const stepMeters = (2 * gridSizeMeters) / gridResolution; // Total span is 2 * gridSizeMeters

    const deltaLat = stepMeters / 111000; // Approximation: 1 degree latitude ≈ 111 km
    const deltaLon = stepMeters / (111000 * Math.cos(THREE.MathUtils.degToRad(center.latitude))); // Adjust for longitude

    for (let i = 0; i < gridResolution; i++) {
        for (let j = 0; j < gridResolution; j++) {
            const latOffset = (i - gridResolution / 2) * deltaLat;
            const lonOffset = (j - gridResolution / 2) * deltaLon;

            const point = {
                latitude: center.latitude + latOffset,
                longitude: center.longitude + lonOffset
            };
            points.push(point);
        }
    }

    return points; // Should return 40,000 points for 200x200 grid
}

/**
 * Fetches elevation data for an array of geographic points with concurrency control and retries.
 * @param {Array} points - Array of points with latitude and longitude.
 * @param {string} units - Units for elevation ('Meters' or 'Feet').
 * @param {number} concurrency - Number of simultaneous API requests.
 * @param {number} retries - Number of retry attempts for failed requests.
 * @returns {Array} Array of points with elevation data.
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
        console.error(`Failed to fetch elevation for (${latitude}, ${longitude}):`, error);
        return null; // Indicate failure
    }
}

/**
 * Initializes the Three.js point cloud for terrain rendering.
 */
function initializeTerrainPointCloud() {
    terrainGeometry = new THREE.BufferGeometry();
    terrainGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));

    terrainMaterial = new THREE.PointsMaterial({
        color: 0xffffff, // White color
        size: 1,          // 1 unit large
    });

    terrainPointCloud = new THREE.Points(terrainGeometry, terrainMaterial);
    scene.add(terrainPointCloud);

    console.log("Terrain point cloud initialized.");
}

/**
 * Renders new terrain points from the elevationData array into the terrainPointCloud.
 * Should be called in the animation loop.
 */
function renderTerrainPoints() {
    if (!terrainPointCloud || window.elevationData.length === 0) return;

    // Access existing geometry and position array
    const existingPositions = terrainPointCloud.geometry.attributes.position.array;
    const currentPointCount = existingPositions.length / 3;

    // Determine how many points to add this frame
    const pointsToAdd = Math.min(POINTS_BATCH_SIZE, window.elevationData.length);

    if (pointsToAdd === 0) return;

    // Create a new Float32Array with the new points
    const newPositions = new Float32Array(pointsToAdd * 3);
    for (let i = 0; i < pointsToAdd; i++) {
        const point = window.elevationData.shift();
        newPositions[i * 3] = (point.longitude - window.longitude) * 100; // x
        newPositions[i * 3 + 1] = point.elevation; // y
        newPositions[i * 3 + 2] = (point.latitude - window.latitude) * 100; // z
    }

    // Concatenate existing positions with new positions
    const updatedPositions = new Float32Array(existingPositions.length + newPositions.length);
    updatedPositions.set(existingPositions, 0);
    updatedPositions.set(newPositions, existingPositions.length);

    // Update the geometry attribute
    terrainPointCloud.geometry.setAttribute('position', new THREE.BufferAttribute(updatedPositions, 3));
    terrainPointCloud.geometry.attributes.position.needsUpdate = true;

    // Since all points are white, no need to update colors

    // Log progress
    const totalPoints = 200 * 200; // 40,000 points
    console.log(`Rendered ${currentPointCount + pointsToAdd} / ${totalPoints} points.`); // e.g., 100 / 40000

    // If all points have been rendered, you can perform any final actions here
    if (currentPointCount + pointsToAdd >= totalPoints) {
        console.log("All terrain points have been rendered.");
        // Optionally, remove the render function from the animation loop or perform cleanup
    }
}

// Expose the renderTerrainPoints function to the window object for access in app.js
window.renderTerrainPoints = renderTerrainPoints;

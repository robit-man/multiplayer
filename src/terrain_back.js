// terrainInit.js

// Ensure this script runs after Three.js is loaded and the scene is initialized

// Flag to prevent multiple initializations
let terrainInitialized = false;

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

    try {
        // Step 1: Generate Grid Points
        const gridSizeKm = 1; // 1 km radius
        const resolution = 10; // 10 points per km
        const gridPoints = generateGrid({ latitude, longitude }, gridSizeKm, resolution);

        console.log(`Generated ${gridPoints.length} grid points.`);

        // Step 2: Fetch Elevation Data
        const elevationData = await fetchElevationGrid(gridPoints, 'Meters', 5, 2);

        console.log('Fetched elevation data:', elevationData);

        // Step 3: Create Terrain Point Cloud
        const elevationScale = 0.01; // Adjust based on your Three.js scene scale
        createTerrainPointCloud(elevationData, elevationScale);

        console.log("Terrain initialization complete.");

        // Mark terrain as initialized
        terrainInitialized = true;
    } catch (error) {
        console.error("Error during terrain initialization:", error);
    }
});

/**
 * Generates a grid of geographic points around a center location.
 * @param {Object} center - The center point with latitude and longitude.
 * @param {number} gridSizeKm - The radius around the center in kilometers.
 * @param {number} resolution - Number of points per kilometer.
 * @returns {Array} Array of points with latitude and longitude.
 */
function generateGrid(center, gridSizeKm = 1, resolution = 10) {
    const points = [];
    const deltaKm = gridSizeKm / resolution;
    const deltaLat = deltaKm / 111; // Approximation: 1 degree latitude ≈ 111 km
    const deltaLon = deltaKm / (111 * Math.cos(center.latitude * Math.PI / 180)); // Adjust for longitude

    for (let latOffset = -gridSizeKm; latOffset <= gridSizeKm; latOffset += deltaKm) {
        for (let lonOffset = -gridSizeKm; lonOffset <= gridSizeKm; lonOffset += deltaKm) {
            const point = {
                latitude: center.latitude + (latOffset / 111),
                longitude: center.longitude + (lonOffset / (111 * Math.cos(center.latitude * Math.PI / 180)))
            };
            points.push(point);
        }
    }

    return points;
}

/**
 * Fetches elevation data for an array of geographic points with concurrency control and retries.
 * @param {Array} points - Array of points with latitude and longitude.
 * @param {string} units - Units for elevation ('Meters' or 'Feet').
 * @param {number} concurrency - Number of simultaneous API requests.
 * @param {number} retries - Number of retry attempts for failed requests.
 * @returns {Array} Array of points with elevation data.
 */
async function fetchElevationGrid(points, units = 'Meters', concurrency = 5, retries = 2) {
    const elevations = [];
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
            console.warn(`Retrying elevation fetch for (${latitude}, ${longitude}) - Attempt ${attempt + 1}`);
            return await fetchWithRetry(longitude, latitude, attempt + 1);
        }
        return elevation;
    };

    /**
     * Worker function to process grid points.
     */
    const worker = async () => {
        while (index < points.length) {
            const currentIndex = index++;
            const point = points[currentIndex];
            const elevation = await fetchWithRetry(point.longitude, point.latitude, 1);
            elevations[currentIndex] = {
                ...point,
                elevation
            };
        }
    };

    // Initialize workers
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    return elevations;
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
 * Creates a Three.js point cloud representing the terrain based on elevation data.
 * @param {Array} elevationData - Array of points with latitude, longitude, and elevation.
 * @param {number} scale - Scaling factor for elevation.
 * @returns {THREE.Points} The generated point cloud.
 */
function createTerrainPointCloud(elevationData, scale = 1) {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];

    const color = new THREE.Color();

    elevationData.forEach(point => {
        if (point.elevation !== null && point.elevation > -100 && point.elevation < 9000) { // Valid elevation range
            // Convert geographic coordinates to Three.js coordinates
            // Assuming a flat Earth for small grid sizes
            const x = (point.longitude - window.longitude) * 100; // Scale longitude
            const z = (point.latitude - window.latitude) * 100;   // Scale latitude
            const y = point.elevation * scale;

            positions.push(x, y, z);

            // Color based on elevation (optional)
            // Example: Lower elevations are green, higher are brown
            const elevationRatio = (point.elevation) / 1000; // Adjust based on expected max elevation
            color.setHSL(0.3 - (elevationRatio * 0.1), 1.0, 0.5); // Customize HSL as needed
            colors.push(color.r, color.g, color.b);
        }
    });

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 0.05,
        vertexColors: true,
        transparent: true,
        opacity: 0.8
    });

    const pointCloud = new THREE.Points(geometry, material);
    scene.add(pointCloud);

    return pointCloud;
}

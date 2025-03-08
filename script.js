let map;
let userMarker;
let reportMarkers = [];
let userLocation = null;
let selectedPhoto = null;
let currentBounds = null;
let trainStationsLayer = null;
let tramRoutesLayer = null;
let busStopsLayer = null;
let markersClustersLayer = null;
let supabase = null;
let loadedAreas = {
    trains: [],
    trams: [],
    buses: []
};

async function initSupabase() {
    try {
        console.log('Fetching Supabase config from API...');
        
        const createDummyClient = () => {
            return {
                from: (table) => ({
                    select: () => ({
                        gte: () => ({
                            order: () => ({
                                then: (callback) => {
                                    callback({ data: reports, error: null });
                                    return { catch: () => {} };
                                }
                            })
                        })
                    }),
                    insert: () => ({
                        then: (callback) => {
                            callback({ data: { id: Date.now() }, error: null });
                            return { catch: () => {} };
                        }
                    })
                }),
                storage: {
                    from: () => ({
                        upload: () => ({ data: { path: 'dummy-path' }, error: null }),
                        getPublicUrl: () => ({ data: { publicUrl: 'https://via.placeholder.com/300x200' } })
                    })
                },
                channel: () => ({
                    on: () => ({
                        subscribe: () => {}
                    })
                })
            };
        };
        
        try {
            const response = await fetch('/api/supabase-config');
            
            console.log('API Response status:', response.status);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('API Error Response:', errorText);
                throw new Error(`API returned ${response.status}: ${response.statusText}`);
            }
            
            const config = await response.json();
            console.log('Supabase config received (keys hidden):', {
                ...config,
                supabaseUrl: config.supabaseUrl ? '[PRESENT]' : '[MISSING]',
                supabaseAnonKey: config.supabaseAnonKey ? '[PRESENT]' : '[MISSING]'
            });
            
            if (!config.supabaseUrl || !config.supabaseAnonKey) {
                console.warn('Supabase configuration is incomplete, using offline mode');
                supabase = createDummyClient();
            } else {
                if (window.supabaseClient) {
                    supabase = window.supabaseClient.createClient(config.supabaseUrl, config.supabaseAnonKey);
                } else if (window.supabase && window.supabase.createClient) {
                    supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
                } else {
                    throw new Error('Supabase client not available');
                }
            }
        } catch (error) {
            console.error('Error connecting to Supabase:', error);
            console.warn('Using offline mode with sample data');
            supabase = createDummyClient();
        }
        
        console.log('Supabase initialized successfully (real or offline mode)');
        
        loadReports();
    } catch (error) {
        console.error('Unexpected error in initSupabase:', error);
        refreshReportMarkers();
        renderRecentReports();
    }
}

const PTV_API = {
    baseUrl: 'https://timetableapi.ptv.vic.gov.au',
    devId: 'your-dev-id',
    apiKey: 'your-api-key',
    
    generateSignature: function(path) {
        const crypto = window.crypto || window.msCrypto;
        const encoder = new TextEncoder();
        const data = encoder.encode(path + this.apiKey);
        
        return crypto.subtle.digest('SHA-1', data)
            .then(hashBuffer => {
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            });
    },
    
    buildUrl: async function(endpoint, params = {}) {
        let url = `${this.baseUrl}${endpoint}?dev_id=${this.devId}`;
        
        Object.keys(params).forEach(key => {
            url += `&${key}=${encodeURIComponent(params[key])}`;
        });
        
        const signature = await this.generateSignature(url.replace(this.baseUrl, ''));
        url += `&signature=${signature}`;
        
        return url;
    },
    
    fetchData: async function(endpoint, params = {}) {
        try {
            const url = await this.buildUrl(endpoint, params);
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('Error fetching data from PTV API:', error);
            return null;
        }
    },
    
    getTrainStations: async function(bounds) {
        const latDiff = bounds.north - bounds.south;
        const lngDiff = bounds.east - bounds.west;
        const boundsSize = Math.max(latDiff, lngDiff);
        
        if (boundsSize > 0.1) {
            const searchPoints = this.generateSearchGrid(bounds, 3);
            const allResults = await Promise.all(
                searchPoints.map(point => {
                    const params = {
                        latitude: point.lat.toFixed(6),
                        longitude: point.lng.toFixed(6),
                        max_distance: 10000,
                        route_types: 0,
                    };
                    return this.fetchData('/v3/stops/location', params);
                })
            );
            
            const mergedResults = { stops: [] };
            const stopIds = new Set();
            
            allResults.forEach(result => {
                if (result && result.stops) {
                    result.stops.forEach(stop => {
                        if (!stopIds.has(stop.stop_id)) {
                            stopIds.add(stop.stop_id);
                            mergedResults.stops.push(stop);
                        }
                    });
                }
            });
            
            return mergedResults;
        } else {
            const params = {
                latitude: ((bounds.north + bounds.south) / 2).toFixed(6),
                longitude: ((bounds.east + bounds.west) / 2).toFixed(6),
                max_distance: 10000,
                route_types: 0,
            };
            
            return this.fetchData('/v3/stops/location', params);
        }
    },
    
    getTramStops: async function(bounds) {
        const latDiff = bounds.north - bounds.south;
        const lngDiff = bounds.east - bounds.west;
        const boundsSize = Math.max(latDiff, lngDiff);
        
        if (boundsSize > 0.1) {
            const searchPoints = this.generateSearchGrid(bounds, 2);
            const allResults = await Promise.all(
                searchPoints.map(point => {
                    const params = {
                        latitude: point.lat.toFixed(6),
                        longitude: point.lng.toFixed(6),
                        max_distance: 8000,
                        route_types: 1,
                    };
                    return this.fetchData('/v3/stops/location', params);
                })
            );
            
            const mergedResults = { stops: [] };
            const stopIds = new Set();
            
            allResults.forEach(result => {
                if (result && result.stops) {
                    result.stops.forEach(stop => {
                        if (!stopIds.has(stop.stop_id)) {
                            stopIds.add(stop.stop_id);
                            mergedResults.stops.push(stop);
                        }
                    });
                }
            });
            
            return mergedResults;
        } else {
            const params = {
                latitude: ((bounds.north + bounds.south) / 2).toFixed(6),
                longitude: ((bounds.east + bounds.west) / 2).toFixed(6),
                max_distance: 8000,
                route_types: 1,
            };
            
            return this.fetchData('/v3/stops/location', params);
        }
    },
    
    getBusStops: async function(bounds) {
        const latDiff = bounds.north - bounds.south;
        const lngDiff = bounds.east - bounds.west;
        const boundsSize = Math.max(latDiff, lngDiff);
        
        if (boundsSize > 0.1) {
            const searchPoints = this.generateSearchGrid(bounds, 3);
            const allResults = await Promise.all(
                searchPoints.map(point => {
                    const params = {
                        latitude: point.lat.toFixed(6),
                        longitude: point.lng.toFixed(6),
                        max_distance: 5000,
                        route_types: 2,
                    };
                    return this.fetchData('/v3/stops/location', params);
                })
            );
            
            const mergedResults = { stops: [] };
            const stopIds = new Set();
            
            allResults.forEach(result => {
                if (result && result.stops) {
                    result.stops.forEach(stop => {
                        if (!stopIds.has(stop.stop_id)) {
                            stopIds.add(stop.stop_id);
                            mergedResults.stops.push(stop);
                        }
                    });
                }
            });
            
            return mergedResults;
        } else {
            const params = {
                latitude: ((bounds.north + bounds.south) / 2).toFixed(6),
                longitude: ((bounds.east + bounds.west) / 2).toFixed(6),
                max_distance: 5000,
                route_types: 2,
            };
            
            return this.fetchData('/v3/stops/location', params);
        }
    },
    
    generateSearchGrid: function(bounds, gridSize) {
        const points = [];
        const latStep = (bounds.north - bounds.south) / (gridSize - 1);
        const lngStep = (bounds.east - bounds.west) / (gridSize - 1);
        
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                points.push({
                    lat: bounds.south + (i * latStep),
                    lng: bounds.west + (j * lngStep)
                });
            }
        }
        
        return points;
    },
    
    getRoutes: async function(routeType) {
        const params = {
            route_types: routeType
        };
        
        return this.fetchData('/v3/routes', params);
    },
    
    getRouteStops: async function(routeId, routeType) {
        return this.fetchData(`/v3/stops/route/${routeId}/route_type/${routeType}`);
    }
};

let reports = [
    { id: 1, line: 'train', station: 'Flinders Street Station', lat: -37.8183, lng: 144.9671, timestamp: Date.now() - 1800000, notes: '2 officers checking tickets at main entrance', imageUrl: 'https://via.placeholder.com/300x200' },
    { id: 2, line: 'tram', station: 'Bourke St/Swanston St', lat: -37.8133, lng: 144.9680, timestamp: Date.now() - 3600000, notes: 'Officers checking myki on Route 86 tram', imageUrl: 'https://via.placeholder.com/300x200' },
    { id: 3, line: 'train', station: 'Southern Cross Station', lat: -37.8184, lng: 144.9520, timestamp: Date.now() - 7200000, notes: 'Officers at ticket barriers', imageUrl: 'https://via.placeholder.com/300x200' }
];

const reportButton = document.getElementById('reportButton');
const reportModal = document.getElementById('reportModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const cancelReport = document.getElementById('cancelReport');
const reportForm = document.getElementById('reportForm');
const locationPrompt = document.getElementById('locationPrompt');
const enableLocationBtn = document.getElementById('enableLocation');
const toast = document.getElementById('toast');
const filterBtns = document.querySelectorAll('.filter-btn');
const lineFilter = document.getElementById('lineFilter');
const recentReportsContainer = document.getElementById('recentReports');

const photoUpload = document.getElementById('photoUpload');
const photoDropArea = document.getElementById('photoDropArea');
const photoPlaceholder = document.getElementById('photoPlaceholder');
const photoPreview = document.getElementById('photoPreview');
const previewImage = document.getElementById('previewImage');
const removePhoto = document.getElementById('removePhoto');

async function loadReports() {
    try {
        const hoursAgo = 24;
        const timestamp = new Date();
        timestamp.setHours(timestamp.getHours() - hoursAgo);

        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .gte('timestamp', timestamp.toISOString())
            .order('timestamp', { ascending: false });

        if (error) throw error;

        if (data) {
            reports = data.map(report => ({
                id: report.id,
                line: report.line_type,
                station: report.station_name,
                lat: report.latitude,
                lng: report.longitude,
                timestamp: new Date(report.timestamp).getTime(),
                notes: report.notes,
                imageUrl: report.image_url
            }));
            
            refreshReportMarkers();
            renderRecentReports();
        }
    } catch (error) {
        console.error('Error loading reports:', error);
        
        console.log('Using fallback report data');
        refreshReportMarkers();
        renderRecentReports();
    }
}

async function uploadImage(file) {
    try {
        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}.${fileExt}`;
        const filePath = `${fileName}`;

        const { data, error } = await supabase.storage
            .from('report-images')
            .upload(filePath, file);

        if (error) throw error;

        const { data: { publicUrl } } = supabase.storage
            .from('report-images')
            .getPublicUrl(filePath);

        return publicUrl;
    } catch (error) {
        console.error('Error uploading image:', error);
        throw error;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("App initializing...");
    initMap();
    checkLocationPermission();
    initSupabase();
    
    reportButton.addEventListener('click', openReportModal);
    closeModalBtn.addEventListener('click', closeReportModal);
    cancelReport.addEventListener('click', closeReportModal);
    reportForm.addEventListener('submit', handleReportSubmission);
    enableLocationBtn.addEventListener('click', requestLocationPermission);
    
    photoUpload.addEventListener('change', handlePhotoSelect);
    removePhoto.addEventListener('click', removeSelectedPhoto);
    
    photoDropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        photoDropArea.classList.add('dragover');
    });
    
    photoDropArea.addEventListener('dragleave', () => {
        photoDropArea.classList.remove('dragover');
    });
    
    photoDropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        photoDropArea.classList.remove('dragover');
        
        if (e.dataTransfer.files.length) {
            handlePhotoFile(e.dataTransfer.files[0]);
        }
    });
    
    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => b.classList.remove('active', 'bg-blue-500', 'text-white'));
            filterBtns.forEach(b => b.classList.add('bg-blue-100', 'text-blue-800'));
            
            btn.classList.remove('bg-blue-100', 'text-blue-800');
            btn.classList.add('active', 'bg-blue-500', 'text-white');
            
            filterReports();
        });
    });
    
    lineFilter.addEventListener('change', filterReports);
    
    console.log("App initialization complete");
});

function initMap() {
    console.log("Initializing map...");
    map = L.map('map').setView([-37.8136, 144.9631], 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    
    trainStationsLayer = L.layerGroup().addTo(map);
    tramRoutesLayer = L.layerGroup().addTo(map);
    busStopsLayer = L.markerClusterGroup({
        disableClusteringAtZoom: 15,
        maxClusterRadius: 40,
        iconCreateFunction: function(cluster) {
            return L.divIcon({
                html: `<div class="bus-cluster">${cluster.getChildCount()}</div>`,
                className: 'bus-cluster-icon',
                iconSize: [40, 40]
            });
        }
    }).addTo(map);
    
    const overlays = {
        "Train Stations": trainStationsLayer,
        "Tram Routes": tramRoutesLayer,
        "Bus Stops": busStopsLayer
    };
    L.control.layers(null, overlays, {collapsed: false}).addTo(map);
    
    refreshReportMarkers();
    
    const loadingIndicator = L.DomUtil.create('div', 'map-loading');
    loadingIndicator.innerHTML = '<div class="loading-indicator"></div><p class="text-center mt-2">Loading transport data...</p>';
    map.getContainer().appendChild(loadingIndicator);
    
    function toggleLoading(show) {
        loadingIndicator.style.display = show ? 'flex' : 'none';
    }
    
    map.on('moveend', async function() {
        console.log('Map moved - loading transport data');
        toggleLoading(true);
        
        const bounds = map.getBounds();
        const boundingBox = {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
        
        console.log('Current map bounds:', boundingBox);
        
        try {
            await Promise.all([
                loadTrainStations(boundingBox, trainStationsLayer),
                loadTramRoutes(boundingBox, tramRoutesLayer),
                loadBusStops(boundingBox, busStopsLayer)
            ]);
        } catch (error) {
            console.error('Error loading transport data:', error);
            loadFallbackTrainStations(boundingBox, trainStationsLayer);
            loadFallbackTramRoutes(boundingBox, tramRoutesLayer);
            loadFallbackBusStops(boundingBox, busStopsLayer);
        } finally {
            toggleLoading(false);
        }
    });
    
    (async function initialDataLoad() {
        toggleLoading(true);
        const initialBounds = {
            north: map.getBounds().getNorth(),
            south: map.getBounds().getSouth(),
            east: map.getBounds().getEast(),
            west: map.getBounds().getWest()
        };
        
        console.log('Initial map bounds:', initialBounds);
        
        try {
            await Promise.all([
                loadTrainStations(initialBounds, trainStationsLayer),
                loadTramRoutes(initialBounds, tramRoutesLayer),
                loadBusStops(initialBounds, busStopsLayer)
            ]);
        } catch (error) {
            console.error('Error during initial data load:', error);
            loadFallbackTrainStations(initialBounds, trainStationsLayer);
            loadFallbackTramRoutes(initialBounds, tramRoutesLayer);
            loadFallbackBusStops(initialBounds, busStopsLayer);
        } finally {
            toggleLoading(false);
        }
    })();
    
    console.log("Map initialization complete");
}

async function loadTrainStations(bounds, layer) {
    console.log("Loading train stations from PTV API for area:", bounds);
    
    try {
        layer.clearLayers();
        
        const data = await PTV_API.getTrainStations(bounds);
        
        if (!data || !data.stops || data.stops.length === 0) {
            console.log('No train stations found in API response, using fallback data');
            loadFallbackTrainStations(bounds, layer);
            return;
        }
        
        console.log(`Found ${data.stops.length} train stations from API`);
        
        data.stops.forEach(station => {
            try {
                const stationMarker = L.circleMarker([station.stop_latitude, station.stop_longitude], {
                    radius: 6,
                    fillColor: "#003399",
                    color: "#000",
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.8
                });
                
                stationMarker.bindPopup(`
                    <div class="station-popup">
                        <h3 class="font-bold">${station.stop_name}</h3>
                        <p class="text-sm">Train Station</p>
                        ${station.route_id ? `<p class="text-xs text-gray-600">Route ID: ${station.route_id}</p>` : ''}
                    </div>
                `);
                
                stationMarker.addTo(layer);
            } catch (error) {
                console.error(`Error adding train station ${station.stop_name}:`, error);
            }
        });
    } catch (error) {
        console.error('Error fetching train stations from API:', error);
        loadFallbackTrainStations(bounds, layer);
    }
}

async function loadTramRoutes(bounds, layer) {
    console.log("Loading tram routes from PTV API for area:", bounds);
    
    try {
        layer.clearLayers();
        
        const data = await PTV_API.getTramStops(bounds);
        
        if (!data || !data.stops || data.stops.length === 0) {
            console.log('No tram stops found in API response, using fallback data');
            loadFallbackTramRoutes(bounds, layer);
            return;
        }
        
        console.log(`Found ${data.stops.length} tram stops from API`);
        
        const routeGroups = {};
        
        data.stops.forEach(stop => {
            const routeId = stop.route_id || 'unknown';
            if (!routeGroups[routeId]) {
                routeGroups[routeId] = [];
            }
            routeGroups[routeId].push([stop.stop_latitude, stop.stop_longitude]);
        });
        
        Object.keys(routeGroups).forEach((routeId, index) => {
            try {
                const stops = routeGroups[routeId];
                
                const routeLine = L.polyline(stops, {
                    color: "#78BE20",
                    weight: 4,
                    opacity: 0.7,
                    lineCap: 'round',
                    lineJoin: 'round'
                });
                
                routeLine.bindPopup(`<b>Tram Route ${routeId}</b>`);
                routeLine.addTo(layer);
                
                stops.forEach((coords, i) => {
                    L.circleMarker(coords, {
                        radius: 3,
                        fillColor: "#78BE20",
                        color: "#000",
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 0.8
                    }).addTo(layer);
                });
            } catch (error) {
                console.error(`Error adding tram route ${routeId}:`, error);
            }
        });
    } catch (error) {
        console.error('Error fetching tram routes from API:', error);
        loadFallbackTramRoutes(bounds, layer);
    }
}

async function loadBusStops(bounds, layer) {
    console.log("Loading bus stops from PTV API for area:", bounds);
    
    try {
        layer.clearLayers();
        
        const data = await PTV_API.getBusStops(bounds);
        
        if (!data || !data.stops || data.stops.length === 0) {
            console.log('No bus stops found in API response, using fallback data');
            loadFallbackBusStops(bounds, layer);
            return;
        }
        
        console.log(`Found ${data.stops.length} bus stops from API`);
        
        data.stops.forEach(stop => {
            try {
                const busIcon = L.divIcon({
                    html: `<div style="background-color: #FF8200; width: 8px; height: 8px; border-radius: 50%; border: 1px solid #000;"></div>`,
                    className: 'bus-stop-marker',
                    iconSize: [8, 8]
                });
                
                const stopMarker = L.marker([stop.stop_latitude, stop.stop_longitude], { icon: busIcon });
                
                stopMarker.bindPopup(`
                    <div class="bus-stop-popup">
                        <h3 class="font-bold">${stop.stop_name}</h3>
                        <p class="text-sm">Bus Stop</p>
                        ${stop.route_id ? `<p class="text-xs text-gray-600">Route: ${stop.route_id}</p>` : ''}
                    </div>
                `);
                
                layer.addLayer(stopMarker);
            } catch (error) {
                console.error(`Error adding bus stop ${stop.stop_name}:`, error);
            }
        });
    } catch (error) {
        console.error('Error fetching bus stops from API:', error);
        loadFallbackBusStops(bounds, layer);
    }
}

function loadFallbackTrainStations(bounds, layer) {
    console.log("Loading fallback train stations for area:", bounds);
    
    layer.clearLayers();
    
    const majorStations = [
        {name: "Flinders Street", lat: -37.8183, lng: 144.9671},
        {name: "Southern Cross", lat: -37.8184, lng: 144.9520},
        {name: "Melbourne Central", lat: -37.8100, lng: 144.9628},
        {name: "Parliament", lat: -37.8113, lng: 144.9729},
        {name: "Richmond", lat: -37.8239, lng: 144.9969},
        {name: "South Yarra", lat: -37.8387, lng: 144.9925},
        {name: "Footscray", lat: -37.8008, lng: 144.9032},
        {name: "Box Hill", lat: -37.8193, lng: 145.1219},
        {name: "Caulfield", lat: -37.8772, lng: 145.0417},
        {name: "Dandenong", lat: -37.9883, lng: 145.2148},
        {name: "Clifton Hill", lat: -37.7858, lng: 144.9944},
        {name: "North Melbourne", lat: -37.8072, lng: 144.9419},
        {name: "Sunshine", lat: -37.7891, lng: 144.8320},
        {name: "Ringwood", lat: -37.8153, lng: 145.2288},
        {name: "Camberwell", lat: -37.8263, lng: 145.0581}
    ];
    
    const stationsInBounds = majorStations.filter(station => {
        return (
            station.lat >= bounds.south && 
            station.lat <= bounds.north && 
            station.lng >= bounds.west && 
            station.lng <= bounds.east
        );
    });
    
    console.log(`Found ${stationsInBounds.length} train stations in the current map view`);
    
    stationsInBounds.forEach(station => {
        try {
            L.circleMarker([station.lat, station.lng], {
                radius: 5,
                fillColor: "#003399",
                color: "#000",
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            }).bindPopup(`<b>Station:</b> ${station.name}`).addTo(layer);
        } catch (error) {
            console.error(`Error adding train station ${station.name}:`, error);
        }
    });
}

function loadFallbackTramRoutes(bounds, layer) {
    console.log("Loading fallback tram routes for area:", bounds);
    
    layer.clearLayers();
    
    const tramCorridors = [
        [[-37.8090, 144.9631], [-37.8296, 144.9696]],
        [[-37.8150, 144.9558], [-37.8130, 144.9730]],
        [[-37.8166, 144.9558], [-37.8150, 144.9730]],
        [[-37.8130, 144.9644], [-37.8000, 144.9590]],
        [[-37.8100, 144.9558], [-37.8100, 144.9730]],
        [[-37.8296, 144.9696], [-37.8600, 144.9820]],
        [[-37.7980, 144.9765], [-37.7700, 144.9900]],
        [[-37.8450, 144.9950], [-37.8600, 145.0020]],
        [[-37.8100, 144.9900], [-37.8150, 145.0200]],
        [[-37.7800, 144.9600], [-37.7500, 144.9550]]
    ];
    
    const corridorsInBounds = tramCorridors.filter(corridor => {
        return corridor.some(point => {
            return (
                point[0] >= bounds.south && 
                point[0] <= bounds.north && 
                point[1] >= bounds.west && 
                point[1] <= bounds.east
            );
        });
    });
    
    console.log(`Found ${corridorsInBounds.length} tram corridors in the current map view`);
    
    corridorsInBounds.forEach((corridor, index) => {
        try {
            L.polyline(corridor, {
                color: "#78BE20",
                weight: 3,
                opacity: 0.7
            }).bindPopup(`<b>Tram Corridor</b> ${index + 1}`).addTo(layer);
        } catch (error) {
            console.error(`Error adding tram corridor ${index + 1}:`, error);
        }
    });
}

function loadFallbackBusStops(bounds, layer) {
    console.log("Loading fallback bus stops for area:", bounds);
    
    const busInterchanges = [
        {name: "Flinders Street", lat: -37.8183, lng: 144.9671},
        {name: "Southern Cross", lat: -37.8184, lng: 144.9520},
        {name: "Melbourne Central", lat: -37.8100, lng: 144.9628},
        {name: "Footscray", lat: -37.8008, lng: 144.9032},
        {name: "Box Hill", lat: -37.8193, lng: 145.1219},
        {name: "Chadstone", lat: -37.8851, lng: 145.0795},
        {name: "Doncaster", lat: -37.7834, lng: 145.1231},
        {name: "Northland", lat: -37.7414, lng: 145.0296},
        {name: "Highpoint", lat: -37.7789, lng: 144.8873},
        {name: "Knox City", lat: -37.8712, lng: 145.2407},
        {name: "Frankston", lat: -38.1404, lng: 145.1258}
    ];
    
    const interchangesInBounds = busInterchanges.filter(interchange => {
        return (
            interchange.lat >= bounds.south && 
            interchange.lat <= bounds.north && 
            interchange.lng >= bounds.west && 
            interchange.lng <= bounds.east
        );
    });
    
    console.log(`Found ${interchangesInBounds.length} bus interchanges in the current map view`);
    
    layer.clearLayers();
    
    interchangesInBounds.forEach(interchange => {
        try {
            const busIcon = L.divIcon({
                html: `<div style="background-color: #FF8200; width: 10px; height: 10px; border-radius: 50%; border: 1px solid #000;"></div>`,
                className: 'bus-stop-marker',
                iconSize: [10, 10]
            });
            
            L.marker([interchange.lat, interchange.lng], { icon: busIcon })
                .bindPopup(`<b>Bus Interchange:</b> ${interchange.name}`)
                .addTo(layer);
            
            for (let i = 0; i < 8; i++) {
                const latOffset = (Math.random() - 0.5) * 0.01;
                const lngOffset = (Math.random() - 0.5) * 0.01;
                
                const smallBusIcon = L.divIcon({
                    html: `<div style="background-color: #FF8200; width: 6px; height: 6px; border-radius: 50%; border: 1px solid #000;"></div>`,
                    className: 'bus-stop-marker',
                    iconSize: [6, 6]
                });
                
                L.marker([interchange.lat + latOffset, interchange.lng + lngOffset], { icon: smallBusIcon })
                    .bindPopup(`<b>Bus Stop:</b> Near ${interchange.name}`)
                    .addTo(layer);
            }
        } catch (error) {
            console.error(`Error adding bus interchange ${interchange.name}:`, error);
        }
    });
}

function checkLocationPermission() {
    if (navigator.geolocation) {
        navigator.permissions.query({ name: 'geolocation' }).then(result => {
            if (result.state === 'granted') {
                locationPrompt.style.display = 'none';
                watchUserLocation();
            } else {
                locationPrompt.style.display = 'block';
            }
        }).catch(error => {
            console.log("Permission query not supported. Showing location prompt.");
            locationPrompt.style.display = 'block';
        });
    }
}

function requestLocationPermission() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                locationPrompt.style.display = 'none';
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                updateUserMarker();
                watchUserLocation();
            },
            (error) => {
                console.error("Error obtaining location: ", error);
                alert("Unable to access your location. Some features may be limited.");
            }
        );
    } else {
        alert("Geolocation is not supported by this browser.");
    }
}

function watchUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                updateUserMarker();
            },
            (error) => {
                console.error("Error watching location: ", error);
            }
        );
    }
}

function updateUserMarker() {
    if (!userLocation) return;
    
    if (userMarker) {
        userMarker.setLatLng([userLocation.lat, userLocation.lng]);
    } else {
        const userIcon = L.divIcon({
            html: `<div style="background-color: #3b82f6; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.5);"></div>`,
            className: 'user-marker',
            iconSize: [16, 16]
        });
        
        userMarker = L.marker([userLocation.lat, userLocation.lng], { icon: userIcon }).addTo(map);
        userMarker.bindPopup("Your current location");
        
        map.setView([userLocation.lat, userLocation.lng], 14);
    }
}

function openReportModal() {
    console.log("Opening report modal");
    reportModal.classList.remove('hidden');
    reportModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeReportModal() {
    console.log("Closing report modal");
    reportModal.classList.add('hidden');
    reportModal.style.display = 'none';
    document.body.style.overflow = '';
    reportForm.reset();
    removeSelectedPhoto();
    clearFormErrors();
}

function clearFormErrors() {
    document.getElementById('lineTypeError').classList.add('hidden');
    document.getElementById('stationNameError').classList.add('hidden');
    document.getElementById('photoError').classList.add('hidden');
}

function handlePhotoSelect(e) {
    if (e.target.files.length) {
        handlePhotoFile(e.target.files[0]);
    }
}

function handlePhotoFile(file) {
    if (!file.type.match('image.*')) {
        alert('Please select an image file');
        return;
    }
    
    if (file.size > 5 * 1024 * 1024) {
        alert('File too large. Maximum size is 5MB.');
        return;
    }
    
    selectedPhoto = file;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        previewImage.src = e.target.result;
        photoPlaceholder.classList.add('hidden');
        photoPreview.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

function removeSelectedPhoto() {
    selectedPhoto = null;
    photoPlaceholder.classList.remove('hidden');
    photoPreview.classList.add('hidden');
    photoUpload.value = '';
}

async function handleReportSubmission(e) {
    e.preventDefault();
    
    if (!userLocation) {
        alert("Location access is required to submit a report");
        return;
    }
    
    const lineType = document.getElementById('lineType').value;
    const stationName = document.getElementById('stationName').value;
    const notes = document.getElementById('notes').value;
    
    let isValid = true;
    
    if (!lineType) {
        document.getElementById('lineTypeError').classList.remove('hidden');
        isValid = false;
    } else {
        document.getElementById('lineTypeError').classList.add('hidden');
    }
    
    if (!stationName) {
        document.getElementById('stationNameError').classList.remove('hidden');
        isValid = false;
    } else {
        document.getElementById('stationNameError').classList.add('hidden');
    }
    
    if (!selectedPhoto) {
        document.getElementById('photoError').classList.remove('hidden');
        isValid = false;
    } else {
        document.getElementById('photoError').classList.add('hidden');
    }
    
    if (!isValid) return;
    
    const submitBtn = reportForm.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    submitBtn.disabled = true;
    
    try {
        const imageUrl = await uploadImage(selectedPhoto);
        
        const newReport = {
            line_type: lineType,
            station_name: stationName,
            latitude: userLocation.lat,
            longitude: userLocation.lng,
            timestamp: new Date().toISOString(),
            notes: notes,
            image_url: imageUrl
        };
        
        const { data, error } = await supabase
            .from('reports')
            .insert([newReport]);
            
        if (error) throw error;
        
        closeReportModal();
        showToast('Report submitted successfully!');
        
        loadReports();
    } catch (error) {
        console.error('Error submitting report:', error);
        showToast('Error submitting report. Please try again.', 'error');
    } finally {
        submitBtn.innerHTML = originalBtnText;
        submitBtn.disabled = false;
    }
}

function showToast(message = 'Report submitted successfully!', type = 'success') {
    const toast = document.getElementById('toast');
    
    toast.innerHTML = type === 'success' 
        ? `<i class="fas fa-check-circle mr-2"></i> ${message}`
        : `<i class="fas fa-exclamation-circle mr-2"></i> ${message}`;
    
    if (type === 'success') {
        toast.classList.remove('bg-red-500');
        toast.classList.add('bg-green-500');
    } else {
        toast.classList.remove('bg-green-500');
        toast.classList.add('bg-red-500');
    }
    
    toast.classList.remove('translate-y-24');
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.add('translate-y-24');
        toast.classList.remove('show');
    }, 4000);
}

function showNotification(message) {
    let notification = document.getElementById('notification');
    
    if (!notification) {
        notification = document.createElement('div');
        notification.id = 'notification';
        notification.className = 'fixed top-4 right-4 bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg z-50 transform -translate-y-24 transition-transform duration-300 flex items-center';
        notification.innerHTML = `<i class="fas fa-bell mr-2"></i> <span id="notification-message"></span>`;
        document.body.appendChild(notification);
    }
    
    document.getElementById('notification-message').textContent = message;
    
    notification.classList.remove('-translate-y-24');
    
    setTimeout(() => {
        notification.classList.add('-translate-y-24');
    }, 4000);
}

async function filterReports() {
    const activeFilterBtn = document.querySelector('.filter-btn.active');
    const hoursFilter = parseInt(activeFilterBtn.getAttribute('data-hours'));
    const lineTypeFilter = lineFilter.value;
    
    try {
        const timestamp = new Date();
        timestamp.setHours(timestamp.getHours() - hoursFilter);
        
        let query = supabase
            .from('reports')
            .select('*')
            .gte('timestamp', timestamp.toISOString());
            
        if (lineTypeFilter !== 'all') {
            query = query.eq('line_type', lineTypeFilter);
        }
        
        const { data, error } = await query.order('timestamp', { ascending: false });
        
        if (error) throw error;
        
        if (data) {
            reports = data.map(report => ({
                id: report.id,
                line: report.line_type,
                station: report.station_name,
                lat: report.latitude,
                lng: report.longitude,
                timestamp: new Date(report.timestamp).getTime(),
                notes: report.notes,
                imageUrl: report.image_url
            }));
            
            refreshReportMarkers();
            renderRecentReports();
        }
    } catch (error) {
        console.error('Error filtering reports:', error);
        const currentTime = Date.now();
        const timeThreshold = currentTime - (hoursFilter * 60 * 60 * 1000);
        
        const filteredReports = reports.filter(report => {
            const passesTimeFilter = report.timestamp >= timeThreshold;
            const passesLineFilter = lineTypeFilter === 'all' || report.line === lineTypeFilter;
            return passesTimeFilter && passesLineFilter;
        });
        
        reports = filteredReports;
        
        refreshReportMarkers();
        renderRecentReports();
    }
}

function refreshReportMarkers(hoursFilter = 24, lineTypeFilter = 'all') {
    reportMarkers.forEach(marker => map.removeLayer(marker));
    reportMarkers = [];
    
    const currentTime = Date.now();
    const timeThreshold = currentTime - (hoursFilter * 60 * 60 * 1000);
    
    const filteredReports = reports.filter(report => {
        const passesTimeFilter = report.timestamp >= timeThreshold;
        const passesLineFilter = lineTypeFilter === 'all' || report.line === lineTypeFilter;
        return passesTimeFilter && passesLineFilter;
    });
    
    filteredReports.forEach(report => {
        const markerColor = getLineColor(report.line);
        
        const reportIcon = L.divIcon({
            html: `<div class="pulse-dot" style="background-color: ${markerColor}; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.5);"></div>`,
            className: 'report-marker',
            iconSize: [12, 12]
        });
        
        const marker = L.marker([report.lat, report.lng], { icon: reportIcon }).addTo(map);
        
        const timeAgo = getTimeAgo(report.timestamp);
        marker.bindPopup(`
            <div class="report-popup">
                <h3 class="font-bold">${report.station}</h3>
                <p class="text-sm text-gray-600">${timeAgo}</p>
                <p>${report.notes || 'No additional details'}</p>
                <img src="${report.imageUrl}" alt="Report evidence" class="mt-2 rounded-lg shadow-sm" style="max-width: 100%; max-height: 200px;">
            </div>
        `);
        
        reportMarkers.push(marker);
    });
}

function renderRecentReports(hoursFilter = 24, lineTypeFilter = 'all') {
    const scrollPos = recentReportsContainer.scrollTop;
    
    recentReportsContainer.innerHTML = '';
    
    const currentTime = Date.now();
    const timeThreshold = currentTime - (hoursFilter * 60 * 60 * 1000);
    const veryRecentThreshold = currentTime - (2 * 60 * 1000);
    
    const filteredReports = reports.filter(report => {
        const passesTimeFilter = report.timestamp >= timeThreshold;
        const passesLineFilter = lineTypeFilter === 'all' || report.line === lineTypeFilter;
        return passesTimeFilter && passesLineFilter;
    });
    
    if (filteredReports.length === 0) {
        recentReportsContainer.innerHTML = '<p class="text-gray-500 italic p-4 text-center">No recent reports matching your filters</p>';
        return;
    }
    
    filteredReports.forEach(report => {
        const timeAgo = getTimeAgo(report.timestamp);
        const lineColor = getLineColor(report.line);
        const lineTypeName = getLineTypeName(report.line);
        const isVeryRecent = report.timestamp >= veryRecentThreshold;
        
        const reportEl = document.createElement('div');
        
        let className = 'report-item border-l-4 pl-3 py-3 bg-white rounded-md shadow-sm mb-3 hover:shadow-md transition-shadow duration-200';
        if (isVeryRecent) {
            className += ' new-report';
        }
        reportEl.className = className;
        reportEl.style.borderLeftColor = lineColor;
        
        let reportHtml = `
            <div class="flex justify-between items-start">
                <h3 class="font-bold text-gray-800">${report.station}</h3>
                <span class="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-full">${timeAgo}</span>
            </div>
            <div class="flex items-center mt-1 mb-2">
                <span class="inline-block w-2 h-2 rounded-full mr-2" style="background-color: ${lineColor};"></span>
                <span class="text-xs text-gray-600">${lineTypeName}</span>
            </div>
            <p class="text-sm text-gray-700 mt-1">${report.notes || 'No additional details'}</p>
            <div class="mt-2 flex">
                <img src="${report.imageUrl}" alt="Report" class="w-16 h-16 object-cover rounded shadow-sm hover:w-full hover:h-auto hover:object-contain transition-all duration-300" 
                  onerror="this.onerror=null; this.src='https://via.placeholder.com/300x200?text=No+Image';">
            </div>
        `;
        
        if (isVeryRecent) {
            reportHtml = reportHtml.replace(
                '<h3 class="font-bold text-gray-800">',
                '<h3 class="font-bold text-gray-800 flex items-center"><span class="bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full mr-2 animate-pulse">New</span>'
            );
        }
        
        reportEl.innerHTML = reportHtml;
        
        reportEl.addEventListener('click', () => {
            map.setView([report.lat, report.lng], 15);
            
            const marker = reportMarkers.find(m => 
                m.getLatLng().lat === report.lat && 
                m.getLatLng().lng === report.lng
            );
            
            if (marker) {
                marker.openPopup();
            }
        });
        
        recentReportsContainer.appendChild(reportEl);
    });
    
    const countIndicator = document.createElement('div');
    countIndicator.className = 'text-xs text-gray-500 text-center mt-2 mb-1';
    countIndicator.innerHTML = `Showing ${filteredReports.length} report${filteredReports.length !== 1 ? 's' : ''}`;
    recentReportsContainer.appendChild(countIndicator);
    
    recentReportsContainer.scrollTop = scrollPos;
}

function getLineColor(line) {
    switch(line) {
        case 'train': return '#003399';
        case 'tram': return '#78BE20';
        case 'bus': return '#FF8200';
        case 'vline': return '#8F1A95';
        default: return '#6b7280';
    }
}

function getLineTypeName(line) {
    switch(line) {
        case 'train': return 'Metro Train';
        case 'tram': return 'Yarra Tram';
        case 'bus': return 'Bus Service';
        case 'vline': return 'V/Line Service';
        default: return 'Unknown Service';
    }
}

const locateButton = document.getElementById('locateButton');
locateButton.addEventListener('click', () => {
    if (userLocation) {
        map.setView([userLocation.lat, userLocation.lng], 15);
    } else {
        requestLocationPermission();
    }
});

function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    if (seconds < 60) return `${seconds} seconds ago`;
    
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    
    const days = Math.floor(hours / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
}

supabase
  .channel('public:reports')
  .on('postgres_changes', { 
    event: 'INSERT', 
    schema: 'public', 
    table: 'reports' 
  }, payload => {
    const newReport = {
      id: payload.new.id,
      line: payload.new.line_type,
      station: payload.new.station_name,
      lat: payload.new.latitude,
      lng: payload.new.longitude,
      timestamp: new Date(payload.new.timestamp).getTime(),
      notes: payload.new.notes,
      imageUrl: payload.new.image_url
    };
    
    reports.unshift(newReport);
    
    refreshReportMarkers();
    renderRecentReports();
    
    showNotification('New report added!');
  })
  .subscribe();
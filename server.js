require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const allowedCorsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedCorsOrigins.length === 0 || allowedCorsOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseLatLng(value) {
    if (!value || typeof value !== 'string') return null;
    const [lat, lng] = value.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        hasApiKey: !!GOOGLE_API_KEY
    });
});

// Geocode location
app.get('/api/geocode', async (req, res) => {
    if (!GOOGLE_API_KEY) {
        return res.status(500).json({ error: 'API key not configured' });
    }
    try {
        const { address } = req.query;
        if (!address || typeof address !== 'string' || !address.trim()) {
            return res.status(400).json({ error: 'address is required' });
        }

        const response = await fetch(
            `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`
        );
        if (!response.ok) {
            return res.status(502).json({ error: `Geocode API failed with status ${response.status}` });
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Search nearby bars
app.get('/api/places/nearby', async (req, res) => {
    if (!GOOGLE_API_KEY) {
        return res.status(500).json({ error: 'API key not configured' });
    }
    try {
        const { lat, lng, radius, keyword } = req.query;
        const latitude = Number.parseFloat(lat);
        const longitude = Number.parseFloat(lng);
        const searchRadius = Number.parseFloat(radius);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ error: 'lat and lng must be valid numbers' });
        }
        const textQuery = keyword || 'bar lounge nightclub';

        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.types,places.primaryType,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri'
            },
            body: JSON.stringify({
                textQuery,
                maxResultCount: 20,
                locationBias: {
                    circle: {
                        center: { latitude, longitude },
                        radius: Number.isFinite(searchRadius) && searchRadius > 0 ? searchRadius : 5000.0
                    }
                }
            })
        });
        if (!response.ok) {
            return res.status(502).json({ error: `Places API failed with status ${response.status}` });
        }

        const data = await response.json();

        if (data.places) {
            const barTypes = ['bar', 'night_club', 'pub', 'wine_bar', 'cocktail_bar', 'lounge'];
            const results = data.places
                .filter(place => {
                    const primaryType = place.primaryType || '';
                    const types = place.types || [];
                    const name = (place.displayName?.text || '').toLowerCase();
                    return barTypes.some(bt =>
                        primaryType.includes(bt) ||
                        types.some(t => t.includes(bt) || t.includes('bar')) ||
                        name.includes('bar') || name.includes('lounge') ||
                        name.includes('club') || name.includes('pub')
                    );
                })
                .map(place => ({
                    place_id: place.id,
                    name: place.displayName?.text || 'Unknown',
                    geometry: { location: { lat: place.location?.latitude, lng: place.location?.longitude } },
                    rating: place.rating || 0,
                    user_ratings_total: place.userRatingCount || 0,
                    price_level: place.priceLevel ? parseInt(place.priceLevel.replace('PRICE_LEVEL_', '')) : 3,
                    vicinity: place.formattedAddress || '',
                    types: place.types || [],
                    opening_hours: { open_now: place.currentOpeningHours?.openNow },
                    phone: place.internationalPhoneNumber || null,
                    website: place.websiteUri || null,
                    maps_url: place.googleMapsUri || null
                }));
            res.json({ results, status: 'OK' });
        } else {
            res.json({ results: [], status: data.error ? 'ERROR' : 'ZERO_RESULTS', error: data.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get place details by IDs (for shared crawl links)
app.get('/api/places/details', async (req, res) => {
    if (!GOOGLE_API_KEY) {
        return res.status(500).json({ error: 'API key not configured' });
    }
    try {
        const { ids } = req.query;
        if (!ids) return res.status(400).json({ error: 'Missing ids parameter' });

        const placeIds = ids
            .split(',')
            .map(id => id.trim())
            .filter(Boolean)
            .slice(0, 10); // Limit to 10 venues
        if (!placeIds.length) {
            return res.status(400).json({ error: 'No valid ids provided' });
        }

        const results = await Promise.all(placeIds.map(async (placeId) => {
            const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': GOOGLE_API_KEY,
                    'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,types,primaryType,internationalPhoneNumber,websiteUri,googleMapsUri'
                }
            });
            if (!response.ok) return null;
            const place = await response.json();
            if (place.error) return null;
            return {
                place_id: place.id,
                name: place.displayName?.text || 'Unknown',
                geometry: { location: { lat: place.location?.latitude, lng: place.location?.longitude } },
                rating: place.rating || 0,
                user_ratings_total: place.userRatingCount || 0,
                price_level: place.priceLevel ? parseInt(place.priceLevel.replace('PRICE_LEVEL_', '')) : 3,
                vicinity: place.formattedAddress || '',
                types: place.types || [],
                opening_hours: { open_now: place.currentOpeningHours?.openNow },
                phone: place.internationalPhoneNumber || null,
                website: place.websiteUri || null,
                maps_url: place.googleMapsUri || null
            };
        }));

        res.json({ results: results.filter(Boolean), status: 'OK' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get directions
app.get('/api/directions', async (req, res) => {
    if (!GOOGLE_API_KEY) {
        return res.status(500).json({ error: 'API key not configured' });
    }
    try {
        const { origin, destination, waypoints } = req.query;
        const parsedOrigin = parseLatLng(origin);
        const parsedDestination = parseLatLng(destination);
        if (!parsedOrigin || !parsedDestination) {
            return res.status(400).json({ error: 'origin and destination must be \"lat,lng\"' });
        }

        const requestBody = {
            origin: { location: { latLng: { latitude: parsedOrigin.lat, longitude: parsedOrigin.lng } } },
            destination: { location: { latLng: { latitude: parsedDestination.lat, longitude: parsedDestination.lng } } },
            travelMode: 'DRIVE'
        };

        if (waypoints) {
            const parsedWaypoints = waypoints
                .split('|')
                .map(parseLatLng)
                .filter(Boolean)
                .slice(0, 8);
            if (parsedWaypoints.length) {
                requestBody.intermediates = parsedWaypoints.map(wp => ({
                    location: { latLng: { latitude: wp.lat, longitude: wp.lng } }
                }));
            }
        }

        const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.duration,routes.legs.distanceMeters'
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            return res.status(502).json({ error: `Routes API failed with status ${response.status}` });
        }

        const data = await response.json();

        if (data.routes?.length > 0) {
            const route = data.routes[0];
            res.json({
                routes: [{
                    legs: route.legs.map(leg => ({
                        duration: { value: parseInt(leg.duration?.replace('s', '') || 0), text: formatDuration(parseInt(leg.duration?.replace('s', '') || 0)) },
                        distance: { value: leg.distanceMeters || 0, text: formatDistance(leg.distanceMeters || 0) }
                    })),
                    overview_polyline: { points: route.polyline?.encodedPolyline || '' }
                }]
            });
        } else {
            res.json({ routes: [], error: data.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function formatDuration(seconds) {
    const mins = Math.round(seconds / 60);
    return mins < 60 ? `${mins} mins` : `${Math.floor(mins / 60)} hr ${mins % 60} mins`;
}

function formatDistance(meters) {
    return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

// Booking search endpoint
app.get('/api/booking/search', async (req, res) => {
    try {
        const { name, location } = req.query;
        if (!name) {
            return res.status(400).json({ error: 'Venue name is required' });
        }

        const searchLocation = location || '';
        const searchQuery = searchLocation ? `${name} ${searchLocation}` : name;

        // Generate Google search URL for venue booking
        const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery + ' reservations')}`;

        // Generate SevenRooms search URL
        const sevenroomsUrl = `https://www.sevenrooms.com/explore/search/${encodeURIComponent(name)}`;

        // Generate pre-filled WhatsApp message
        const whatsappMsg = `Hi, I'd like to make a reservation at ${name}. Do you have availability?`;

        res.json({
            venue: name,
            googleSearchUrl,
            sevenroomsUrl,
            whatsappMsg
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/manifest.json', (req, res) => {
    res.json({
        name: 'Crawl',
        short_name: 'Crawl',
        description: 'Bar crawl planner for any city',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0a0f',
        theme_color: '#0a0a0f',
        icons: [{ src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' }]
    });
});

// For local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`API Key: ${GOOGLE_API_KEY ? 'Configured' : 'NOT SET'}`);
    });
}

// Export for Vercel
module.exports = app;

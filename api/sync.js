// Immology Sync — Dome -> Webflow CMS
// Vercel Serverless Function + Cron

const DOME_BASE = "https://pubapi.dome.immo";
const WEBFLOW_BASE = "https://api.webflow.com/v2";

// Webflow Collection IDs
const COLLECTIONS = {
  properties: "66d9c30c0401c652321b3a0d",
  categories: "66d9c30c0401c652321b39e1",
  types: "66d9c30c0401c652321b3a0c",
  locations: "66d9c30c0401c652321b3a0b",
  agents: "66d9c30c0401c652321b3a0e",
};

// Webflow Reference IDs — Property Types
const TYPE_A_VENDRE = "66d9c30c0401c652321b3a12";

// Webflow Reference IDs — Property Categories (Dome type -> Webflow category)
const CATEGORY_MAP = {
  apartment: "66d9c30c0401c652321b3976", // Appartements
  house: "66d9c30c0401c652321b39a2",     // Maisons
};

// Webflow Reference IDs — Agents (Dome agent name -> Webflow agent ID)
const AGENT_MAP = {
  "nicolas freuslon": "66d9c30c0401c652321b3a18",
  "emmanuel brdenk": "66d9c30c0401c652321b3a17",
  "celeste clavel": "66d9c30c0401c652321b3a16",
  "céleste clavel": "66d9c30c0401c652321b3a16",
};

// --- Dome API ---

async function getDomePublications() {
  const allPublications = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const res = await fetch(`${DOME_BASE}/publications/v1?page=${page}&limit=50`, {
      headers: {
        Authorization: `DomeAuth1 ${process.env.DOME_ACCESS_KEY}:${process.env.DOME_SECRET_KEY}`,
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Dome API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    allPublications.push(...(data.publications || []));
    totalPages = data.pagination?.total_pages || 1;
    page++;
  }

  // Only return published properties
  return allPublications.filter((p) => p.status === "published");
}

// --- Webflow API helpers ---

async function webflowGet(path) {
  const res = await fetch(`${WEBFLOW_BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webflow GET ${path} error (${res.status}): ${err}`);
  }
  return res.json();
}

async function webflowPost(path, body) {
  const res = await fetch(`${WEBFLOW_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function webflowPatch(path, body) {
  const res = await fetch(`${WEBFLOW_BASE}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

// --- Webflow location management ---

async function getLocationsMap() {
  const data = await webflowGet(`/collections/${COLLECTIONS.locations}/items`);
  const map = {};
  for (const item of data.items) {
    map[item.fieldData.name.toLowerCase()] = item.id;
  }
  return map;
}

async function createLocation(city) {
  const result = await webflowPost(`/collections/${COLLECTIONS.locations}/items`, {
    fieldData: {
      name: city,
      slug: city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, ""),
      "property-location---description": city,
    },
  });
  if (result.ok) {
    return result.data.id;
  }
  console.error(`Failed to create location ${city}:`, result.data);
  return null;
}

// --- Webflow existing properties ---

async function getExistingProperties() {
  const allItems = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await webflowGet(
      `/collections/${COLLECTIONS.properties}/items?offset=${offset}&limit=${limit}`
    );
    allItems.push(...data.items);
    if (data.items.length < limit) break;
    offset += limit;
  }

  return allItems;
}

// --- Mapping Dome -> Webflow ---

function formatPrice(priceObj) {
  if (!priceObj?.gross_price) return null;
  const num = parseFloat(priceObj.gross_price);
  return num.toLocaleString("fr-FR") + " EUR";
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + "...";
}

function mapPublication(pub, locationsMap, newLocations) {
  const agentName = pub.agent
    ? `${pub.agent.first_name} ${pub.agent.last_name}`.toLowerCase()
    : null;

  const city = pub.city || null;
  let locationId = null;
  if (city) {
    locationId =
      locationsMap[city.toLowerCase()] ||
      newLocations[city.toLowerCase()] ||
      null;
  }

  const fieldData = {
    name: pub.title || `${pub.type || "Bien"} - ${pub.reference}`,
    slug: pub.reference.toLowerCase(),
    "property-listing---about": `<p>${pub.description || ""}</p>`,
    "property-listing---summary": truncate(pub.description || "", 241),
    "property-listing---excerpt": truncate(pub.description || "", 94),
    "property-listing---display-price": formatPrice(pub.price),
    "property-listing---sqf": pub.size ? `${pub.size} m2` : null,
    "property-listing---number-of-bedrooms": pub.bedrooms_count || 0,
    "property-listing---number-of-bathrooms": pub.bathrooms_count || 0,
    "property-listing---number-of-parking-spots": pub.parkings_count || 0,
    "property-listing---address": truncate(
      pub.is_address_anonymous ? pub.city : `${pub.address}, ${pub.city}`,
      40
    ),
    // Reference fields
    "property-listing--property": CATEGORY_MAP[pub.type] || null,
    "property-listing---type": TYPE_A_VENDRE,
    "property-listing---location": locationId,
    "property-listing---agent": agentName ? AGENT_MAP[agentName] || null : null,
    // Switches
    "property-listing---garage": pub.parkings_count > 0,
    "property-listing---heater": pub.heater_type !== null,
    "property-listing---chimney": false,
  };

  // Images — Webflow needs uploaded image URLs
  if (pub.photos?.length > 0) {
    fieldData["property-listing---featured-image"] = {
      url: pub.photos[0].url_high || pub.photos[0].url,
    };
    fieldData["property-listing---featured-images"] = pub.photos.map((p) => ({
      url: p.url_high || p.url,
    }));
    if (pub.photos[0]) {
      fieldData["property-listing---thumbnail-image-v1"] = {
        url: pub.photos[0].url_medium || pub.photos[0].url,
      };
    }
    if (pub.photos[1]) {
      fieldData["property-listing---thumbnail-image-v2"] = {
        url: pub.photos[1].url_medium || pub.photos[1].url,
      };
    }
    if (pub.photos[2]) {
      fieldData["property-listing---thumbnail-image-v3"] = {
        url: pub.photos[2].url_medium || pub.photos[2].url,
      };
    }
  }

  // Remove null values
  for (const key of Object.keys(fieldData)) {
    if (fieldData[key] === null || fieldData[key] === undefined) {
      delete fieldData[key];
    }
  }

  return { fieldData };
}

// --- Main sync ---

async function sync() {
  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  log("Starting sync...");

  // 1. Get Dome publications
  const publications = await getDomePublications();
  log(`Dome: ${publications.length} published properties found`);

  if (publications.length === 0) {
    log("No publications to sync");
    return logs;
  }

  // 2. Get existing Webflow data
  const [locationsMap, existingProperties] = await Promise.all([
    getLocationsMap(),
    getExistingProperties(),
  ]);

  const existingBySlug = {};
  for (const item of existingProperties) {
    existingBySlug[item.fieldData.slug] = item;
  }

  log(`Webflow: ${existingProperties.length} existing properties`);

  // 3. Create missing locations
  const newLocations = {};
  for (const pub of publications) {
    if (pub.city && !locationsMap[pub.city.toLowerCase()]) {
      if (!newLocations[pub.city.toLowerCase()]) {
        const id = await createLocation(pub.city);
        if (id) {
          newLocations[pub.city.toLowerCase()] = id;
          log(`Created location: ${pub.city}`);
        }
        await delay(1000);
      }
    }
  }

  // 4. Sync each publication
  const domeRefs = new Set();

  for (const pub of publications) {
    const ref = pub.reference.toLowerCase();
    domeRefs.add(ref);
    const mapped = mapPublication(pub, locationsMap, newLocations);

    if (existingBySlug[ref]) {
      // Update existing
      const itemId = existingBySlug[ref].id;
      const result = await webflowPatch(
        `/collections/${COLLECTIONS.properties}/items/${itemId}`,
        mapped
      );
      if (result.ok) {
        log(`Updated: ${pub.reference} - ${pub.title}`);
      } else {
        log(`FAILED update ${pub.reference}: ${JSON.stringify(result.data)}`);
      }
    } else {
      // Create new
      const result = await webflowPost(
        `/collections/${COLLECTIONS.properties}/items`,
        mapped
      );
      if (result.ok) {
        log(`Created: ${pub.reference} - ${pub.title}`);
      } else {
        log(`FAILED create ${pub.reference}: ${JSON.stringify(result.data)}`);
      }
    }

    await delay(1000); // Webflow rate limit
  }

  // 5. Unpublish properties no longer in Dome
  for (const item of existingProperties) {
    const slug = item.fieldData.slug;
    // Only unpublish items that look like Dome refs (dom...)
    if (slug.startsWith("dom") && !domeRefs.has(slug) && !item.isDraft) {
      const result = await webflowPatch(
        `/collections/${COLLECTIONS.properties}/items/${item.id}`,
        { isDraft: true }
      );
      if (result.ok) {
        log(`Unpublished (removed from Dome): ${slug}`);
      }
      await delay(1000);
    }
  }

  log(`Sync complete. ${publications.length} properties synced.`);
  return logs;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Vercel handler ---

export default async function handler(req, res) {
  try {
    const logs = await sync();
    res.status(200).json({ success: true, logs });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

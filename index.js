import {
    characters, createOrEditCharacter, event_types,
    eventSource,
    getRequestHeaders,
    saveCharacterDebounced,
    saveSettingsDebounced,
    this_chid
} from "../../../../script.js";

import {SlashCommand} from '../../../slash-commands/SlashCommand.js';
import {SlashCommandParser} from '../../../slash-commands/SlashCommandParser.js';


// public/scripts/extensions/localize-images.js

// Quick note:
// Most of my comments are ai-generated, so they might be a bit... odd.
// I edit them briefly if they stand out as wrong or misleading.
// But, I do miss some of them. Sorry... I'm lazy with comments.
// Sorry if they are confusing!
// However, the really conversational ones are almost always 100% mine.

/**
 * SillyTavern extension: st-image-localizer
 *
 * Functionality:
 *
 * - reads current character JSON (with /api/characters/get)
 * - extracts image URLs
 * - downloads them to:  <data_root>/user/files/charName_N.ext
 * - moves them to:      <public_data_root>/user/images/charName/N.ext
 *          (i.e. <data_root>/../../public/user/images/charName/N.ext on backend)
 * - rewrites JSON fields
 * - saves new JSON to character PNG using /api/characters/merge-attributes
 * - tries to force character cache refresh via emitting "character_edited" event
 */


// ----------------------------------------------------------------------------

// ----- CONFIG ------

const EXTENSION_ID = "localizeImages";

// Image matching.
//
// The old single mega-regex tried to handle markdown AND <img> tags AND
// arbitrary attribute ordering in one pattern. It had a fatal bug: the alt
// sub-pattern in the <img> branch was missing its closing quote, so any tag
// written as `<img alt="..." src="...">` (alt BEFORE src — extremely common,
// and in fact the exact shape this very extension emits) never matched and was
// silently skipped. It also choked on extra attributes like `style="..."`.
//
// Instead we use two small, focused patterns and never assume attribute order:
//   - markdown: `![alt](url)` / `[alt](url)`
//   - html:     `<img ... src="http(s)://...">` with src anywhere in the tag
// For HTML tags the alt text is pulled out separately so order doesn't matter.
// Only http(s) URLs are captured, so already-localized `/user/...` paths are
// left untouched (idempotent re-runs).
const MD_IMAGE_REGEX   = /!?\[(?<alt>[^\]]*?)\]\(\s*(?<url>https?:\/\/[^\s)"'<>]+)\s*\)/gi;
const HTML_IMAGE_REGEX = /<img\b[^>]*?\bsrc\s*=\s*["'](?<url>https?:\/\/[^"'<>\s]+)["'][^>]*?>/gi;
const ALT_ATTR_REGEX   = /\balt\s*=\s*["'](?<alt>[^"']*)["']/i;

// which JSON fields to scan for URLs?
const SCAN_FIELDS = [
    "data.first_mes",
    "data.alternate_greetings",
    "data.creator_notes",
];

// ----------------------------------------------------------------------------

// ----- UTILITIES -----
// ---------- URL EXTRACTION AND REPLACEMENT ----------

/**
 * Extract all URLs from a text block.
 *
 * @param {String} text any text block
 * @returns {[]|*[]} array of URLs
 */
function extractUrls(text) {
    return extractUrlsWithMetadata(text).map(m => m.url);
}

/**
 * Extract all URLs with metadata from a text block.
 *
 * @param {String} text any text block
 * @returns {Array} array of objects: { full, url, alt, attrs, isMarkdown, isHtml }
 */
function extractUrlsWithMetadata(text) {
    if (typeof text !== "string") return [];

    const results = [];

    // Markdown images: ![alt](url) / [alt](url)
    for (const match of text.matchAll(MD_IMAGE_REGEX)) {
        results.push({
            full: match[0],
            url: match.groups.url,
            alt: match.groups.alt || "",
            attrs: "", // markdown carries no extra attributes
            isMarkdown: true,
            isHtml: false,
        });
    }

    // HTML <img> tags: src can sit anywhere among the attributes, and alt is
    // read out of the matched tag separately so its position doesn't matter.
    // We also keep every *other* attribute (style, width, class, …) so they
    // survive localization instead of being thrown away.
    for (const match of text.matchAll(HTML_IMAGE_REGEX)) {
        const altMatch = match[0].match(ALT_ATTR_REGEX);
        results.push({
            full: match[0],
            url: match.groups.url,
            alt: altMatch?.groups?.alt || "",
            attrs: extractExtraAttrs(match[0]),
            isMarkdown: false,
            isHtml: true,
        });
    }

    return results;
}

/**
 * Pull every attribute except src/alt out of an <img> tag, as a single
 * normalized string (e.g. `style="..." width="10"`). Used to carry things
 * like style/positioning through to the rewritten local tag.
 *
 * @param {String} tag full <img ...> tag
 * @returns {String} space-joined extra attributes, or "" if none
 */
function extractExtraAttrs(tag) {
    // Strip the leading "<img" and trailing ">" (and optional self-closing "/").
    const inner = tag.replace(/^<img\b/i, "").replace(/\/?>\s*$/, "");

    const attrs = [];
    // attr="value" / attr='value' — attribute names may contain - and :
    const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
    for (const m of inner.matchAll(ATTR_RE)) {
        const name = m[1].toLowerCase();
        if (name === "src" || name === "alt") continue;
        attrs.push(`${m[1]}=${m[2]}`);
    }
    return attrs.join(" ");
}

/**
 * Replace all image URLs in a text block with local HTML <img> tags.
 *
 * @param {String} text any text block
 * @param urlMap mapping of remote URL -> local path
 * @returns {*} text with replacements
 */
function replaceImagesWithHtml(text, urlMap) {
    const matches = extractUrlsWithMetadata(text);
    let output = text;

    for (const m of matches) {
        const local = urlMap[m.url];
        if (!local) continue;

        // Reassemble the tag keeping alt + any extra attributes (style, width,
        // class, …); only the URL becomes local. Markdown has no extras, so it
        // just gets a clean <img alt src>.
        const parts = ["<img"];
        if (m.alt) parts.push(`alt="${m.alt}"`);
        parts.push(`src="${local}"`);
        if (m.attrs) parts.push(m.attrs);
        const imgTag = parts.join(" ") + ">";

        output = output.replace(m.full, imgTag);
    }

    return output;
}

// ---------- DEEP GET/SET UTILITIES ----------

/**
 * Deep get utility.
 *
 * @param {Object} obj object to read from
 * @param {String} path dot-separated path
 * @param {*} def default value if not found
 * @returns {*} value at path or default
 */
function getDeep(obj, path, def = undefined) {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== "object") return def;
        cur = cur[p];
    }
    return cur === undefined ? def : cur;
}

/**
 * Deep set utility.
 *
 * @param {Object} obj object to write to
 * @param {String} path dot-separated path
 * @param {*} value value to set
 */
function setDeep(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof cur[p] !== "object") cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}

// ----------------------------------------------------------------------------

// ----- CORE FUNCTIONS -----
// ---------- CHARACTER JSON FETCH / MERGE ----------

/**
 * Fetch character JSON via avatar URL.
 *
 * @param {String} avatarUrl character avatar URL
 * @returns {Promise<any>} character JSON
 */
async function fetchCharacterJson(avatarUrl) {
    const res = await fetch("/api/characters/get", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl, format: "json" }),
    });
    if (!res.ok) throw new Error(`Failed to fetch char JSON: ${res.status} \n ${await res.text().catch(() => "")}`);
    return res.json();
}

/**
 * Merge updated attributes into character PNG.
 *
 * @param {String} avatarUrl character avatar URL
 * @param {Object} updatedPayload updated fields to merge
 */
async function mergeCharacterJson(avatarUrl, updatedPayload) {
    const body = {
        avatar: avatarUrl,
        ...updatedPayload,
    };

    const res = await fetch("/api/characters/merge-attributes", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Failed to merge attributes: ${res.status} ${t}`);
    }
}

/// ---------- DOWNLOAD + UPLOAD UTILITIES ----------

function proxied(url) {
    return `/proxy/${encodeURIComponent(url)}`;
}

function proxiedRaw(url) {
    return `/proxy/${url}`;
}

/**
 * Download a remote URL and upload it to /user/files/...
 *
 * @param {String} url remote URL
 * @param {String} charName character name (for filename)
 * @param {Number} fileNumber file number (for filename)
 * @param {String} ext preferred extension (if cannot be determined)
 * @returns {Promise<String>} path to uploaded file
 */
async function downloadToLocal(url, charName, fileNumber = 0, ext = "png") {
    // 1. Download remote file
    const resp = await fetch(proxied(url), {
        method: "GET"
    });
    if (!resp.ok)
        throw new Error(`Failed to download remote: ${url}`);

    const arrayBuffer = await resp.arrayBuffer();

    // 2. Determine extension
    const mime = resp.headers.get("content-type") || "";
    const actualExt = mime.split("/")[1] || ext;

    // 3. Create safe filename (server will also sanitize + validate)
    const safeChar = charName.replace(/[^a-z0-9_-]/gi, "_");
    const filename = `${safeChar}_${fileNumber}.${actualExt}`;

    // 4. Base64 encode
    const uint8 = new Uint8Array(arrayBuffer);
    let binaryStr = "";
    for (let i = 0; i < uint8.length; i++)
        binaryStr += String.fromCharCode(uint8[i]);

    const base64 = btoa(binaryStr);

    // 5. Upload JSON format (no multipart!)
    // This note is because I tried like 30 different backend upload methods.
    // None of them worked properly so I settled on this one.
    const res = await fetch("/api/files/upload", {
        method: "POST",
        headers: {
            ...getRequestHeaders(),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            name: filename,
            data: base64,
        }),
    });

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Upload failed: ${res.status} ${t}`);
    }

    const out = await res.json();

    // Returns something like: { path: "/user/files/char_0.png" }
    return out.path;
}

/**
 * Move a file from /user/files/... to /user/images/...
 *
 * @param {String} localPath source path (e.g. "/user/files/char_0.png")
 * @param {String} charName character name (for destination folder)
 * @param {String} avatarName avatar name (for destination subfolder)
 * @param {Number} fileNumber file number (for filename)
 * @param {String} ext file extension
 * @returns {Promise<String>} destination path (e.g. "/user/images/char/0.png")
 */
async function moveToImages(localPath, charName, avatarName, fileNumber = 0, ext = "png") {
    if (typeof localPath !== "string") {
        throw new Error("moveToImages: localPath must be a string");
    }

    // avatarName is character name plus a number to disambiguate multiple images, literally avatarName = charName#
    // we need the number only
    const charNumber = avatarName.replace(charName, "").replace(/[^0-9]/g, "");
    const safeChar = charName.replace(/[^a-z0-9_-]/gi, "_");
    // Build the path from segments and drop empty ones, otherwise an empty
    // charNumber (single-avatar characters) produced a double slash, e.g.
    // "/user/images/Daeoni//0.png".
    const dest = "/" + ["user", "images", safeChar, charNumber, `${fileNumber}.${ext}`]
        .filter(Boolean)
        .join("/");

    const res = await fetch("/api/plugins/st-image-localizer/move-image", {
        method: "POST",
        headers: {
            ...getRequestHeaders(),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: localPath, // e.g. "/user/files/safeChar_0.png"
            to: dest,        // e.g. "/user/images/safeChar/0.png"
        }),
    });

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`moveToImages failed: ${res.status} ${t}`);
    }

    const out = await res.json();
    // plugin returns { moved: true, path: "/user/images/safeChar/0.png" }
    return out.path || dest;
}

// ---------- FORCE CHARACTER RELOAD ----------

/**
 * Force character reload by re-submitting all fields via /api/characters/edit
 *
 * SO... this doesn't work, i malformed this,
 * and it overwrites the character JSON with just the fields I send, losing everything else.
 *
 * However, emitting the "character_edited" event after updating the PNG...
 * also doesn't work... at all. So yeah... I have no idea how to bust the character cache properly.
 *
 * @param {String} avatarUrl character avatar URL
 * @param {Object} json full character JSON
 */
async function forceCharacterReload(avatarUrl, json) {
    const payload = {
        avatar_url: avatarUrl,
        ch_name: json.data?.name ?? "",
        ch_description: json.data?.description ?? "",
        person: json.data?.personality ?? "",
        scenario: json.data?.scenario ?? "",
        first_mes: json.data?.first_mes ?? "",
        mes_example: json.data?.mes_example ?? "",
        creator_notes: json.data?.creator_notes ?? "",
        system_prompt: json.data?.system_prompt ?? "",
        post_history_instructions: json.data?.post_history_instructions ?? "",
        tags: json.data?.tags ?? [],
        chat: json.chat ?? "",
        create_date: json.create_date ?? "",
        alternate_greetings: json.data?.alternate_greetings ?? [],
    };

    const res = await fetch("/api/characters/edit", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        console.error("[localizeImages] forceCharacterReload failed:", await res.text());
        throw new Error("character edit failed");
    }

    console.log("[localizeImages] Forced character reload via /edit (cache bust triggered)");
}

async function megaCacheBust(avatarUrl, urlMap) {
    console.log("[localizeImages] Forcing megaCacheBust via CORS proxy");

    // Bust each original image through corsProxy
    for (const [remoteUrl, localUrl] of Object.entries(urlMap)) {

        // Remote image bust
        await fetch(proxied(remoteUrl), {
            method: "GET",
            cache: "reload",
        }).catch(err => {
            console.warn("[localizeImages] Failed remote bust:", remoteUrl, err);
        });

        // Local image bust
        await fetch(localUrl, {
            method: "GET",
            cache: "reload",
        }).catch(err => {
            console.warn("[localizeImages] Failed local bust:", localUrl, err);
        });
    }

    // Avatar JSON cache bust
    let curRes = await fetch("/api/characters/get", {
        method: "POST",
        cache: "no-store",
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl, format: "json" }),
    });
    if (!curRes.ok) throw new Error(`Failed to fetch char JSON: ${curRes.status} \n ${await curRes.text().catch(() => "")}`);

    // Avatar JSON cache bust
    curRes = await fetch("/api/characters/get", {
        method: "POST",
        cache: "reload",
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl, format: "json" }),
    });
    if (!curRes.ok) throw new Error(`Failed to fetch char JSON: ${curRes.status} \n ${await curRes.text().catch(() => "")}`);

    const avatarUrlPath = ["/characters/", avatarUrl].join("")
    // avatar image bust
    curRes = await fetch(avatarUrlPath, {
        method: "GET",
        cache: "reload",
        headers: getRequestHeaders(),
    });
    if (!curRes.ok) throw new Error(`Failed to fetch avatar image: ${curRes.status} \n ${await curRes.text().catch(() => "")}`);

    console.log("[localizeImages] Mega cache bust complete.");
}


// ----------------------------------------------------------------------------

// ----- MAIN FUNCTION -----

/**
 * Main function: localize all images in current character card.
 *
 * @returns {Promise<Number>} 1=success, 0=nothing to do, -1=failure
 */
async function localizeImages() {
    const context = SillyTavern.getContext();
    const this_chid = context.characterId
    if (this_chid == null) {
        console.warn("[localizeImages] No character selected");
        return -1;
    }

    const characters = context.characters;
    const char = characters[this_chid];
    if (!char) {
        console.warn("[localizeImages] Invalid character object");
        return -1;
    }

    const avatarUrl = char.avatar;
    const charName = char.data?.name || "Unknown";
    const avatarName = (avatarUrl.split("/").pop() || "character.png").split(".")[0];

    // 1. fetch raw JSON
    const json = await fetchCharacterJson(avatarUrl);

    // 2. find all URLs in all fields
    const urlSet = new Set();
    for (const field of SCAN_FIELDS) {
        const text = getDeep(json, field, "");
        if (Array.isArray(text)) {
            for (const t of text) {
                if (typeof t !== "string") continue;
                const matches = extractUrls(t);
                matches.forEach(u => urlSet.add(u));
            }
            continue;
        }
        if (typeof text !== "string") continue;

        const matches = extractUrls(text);
        matches.forEach(u => urlSet.add(u));

    }

    if (urlSet.size === 0) {
        console.log("[localizeImages] No URLs found.");
        return 0;
    }

    // 3. Download all URLs into user/images/<charName>/
    // Print found URLs
    console.log("[localizeImages] Found URLs:", urlSet);
    const urlMap = {};
    let urlCnt = 0;
    for (const remoteUrl of urlSet) {
        try {
            // infer extension from URL
            const urlParts = remoteUrl.split(".");
            let extensionType = "png";
            if (urlParts.length > 1) {
                const extCandidate = urlParts[urlParts.length - 1].toLowerCase();
                if (["png", "jpg", "jpeg", "gif", "webp"].includes(extCandidate)) {
                    extensionType = extCandidate;
                }
            }

            // 1) upload to /user/files/...
            const tmpPath = await downloadToLocal(remoteUrl, avatarName, urlCnt, extensionType);

            // 2) move to /user/images/<charName>/<avatarName - charName>/N.ext via plugin
            // 3) store mapping for replacement
            urlMap[remoteUrl] = await moveToImages(tmpPath, charName, avatarName, urlCnt, extensionType);
            urlCnt++;
        } catch (err) {
            console.warn("[localizeImages] Failed to convert:", remoteUrl, err);
        }
    }


    // 4. Apply replacements
    const updates = { data: {} };

    for (const field of SCAN_FIELDS) {
        const original = getDeep(json, field, "");

        if (Array.isArray(original)) {
            const newArray = [];
            let changed = false;

            for (const item of original) {
                if (typeof item !== "string") {
                    newArray.push(item);
                    continue;
                }

                const newItem = replaceImagesWithHtml(item, urlMap);
                if (newItem !== item) changed = true;

                newArray.push(newItem);
            }

            if (changed) {
                setDeep(updates.data, field.replace(/^data\./, ""), newArray);
            }

            continue;
        }

        if (typeof original !== "string") continue;

        const newText = replaceImagesWithHtml(original, urlMap);
        if (newText !== original) {
            const pureField = field.replace(/^data\./, "");
            setDeep(updates.data, pureField, newText);
        }
    }


    // If nothing updated: done
    if (Object.keys(updates.data).length === 0) {
        console.log("[localizeImages] No field changes needed.");
        return 0;
    }

    // 5. Save updated PNG card
    await mergeCharacterJson(avatarUrl, updates);

    console.log("[localizeImages] Successfully updated character.");
    await megaCacheBust(avatarUrl, urlMap);
    console.log("[localizeImages] Successfully BUSTED cache.");
    //saveCharacterDebounced();
    //saveSettingsDebounced();
    //context.saveMetadataDebounced();
    //context.createCharacterData
    await context.getCharacters();
    //await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: this_chid, character: characters[this_chid] } });
    //await context.reloadCurrentChat();
    //await context.
    await createOrEditCharacter();


    return 1;
}

// ----------------------------------------------------------------------------

// ----- SLASH COMMAND REGISTRATION -----

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: "localizeimages",
    aliases: ["locimg", "li"],
    description:
        "Downloads all image URLs in the current character card and rewrites them as local file paths.",
    helpString:
        "/localizeimages — scans card fields, downloads images, and updates the PNG.",
    returns: "integer (1=success, 0=nothing to do, -1=failure)",

    callback: () => {
        return localizeImages();
    },

    namedArgumentList: [],
    unnamedArgumentList: [],

}));


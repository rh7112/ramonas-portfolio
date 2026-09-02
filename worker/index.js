// Backs the self-managed photo gallery (issue #10). Everything except the
// /api/* routes below falls straight through to the static assets binding,
// same shape as bbsystems-us's worker/index.ts.
//
// Auth: /api/admin/* is reachable at all only because Cloudflare Access is
// configured (in the dashboard, not here) to gate /admin* and /api/admin/*
// at the edge for ramona.bauch.cc, policy = Ramona + Ryan's emails. This is
// a 2-person tool with nothing to sub-divide, so there's no app-level JWT
// check here the way blog-hurd-cc's admin routes have one -- if a request
// reaches these handlers, Access already approved it.

const MIME_EXTENSIONS = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp'
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/api/gallery' && request.method === 'GET') {
			return listGallery(env);
		}
		if (url.pathname.startsWith('/images/gallery/') && request.method === 'GET') {
			return serveImage(url, env);
		}
		if (url.pathname === '/api/admin/gallery/upload' && request.method === 'POST') {
			return uploadImage(request, env);
		}
		if (url.pathname.startsWith('/api/admin/gallery/') && request.method === 'DELETE') {
			return deleteImage(url, env);
		}

		return env.ASSETS.fetch(request);
	}
};

async function listGallery(env) {
	const listed = await env.GALLERY.list({ include: ['customMetadata'] });
	const photos = listed.objects
		.map((obj) => ({
			key: obj.key,
			url: `/images/gallery/${obj.key}`,
			uploadedAt: obj.uploaded,
			tags: (obj.customMetadata?.tags ?? '')
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean)
		}))
		.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

	return json({ photos }, 200, { 'Cache-Control': 'no-store' });
}

async function serveImage(url, env) {
	const key = decodeURIComponent(url.pathname.replace('/images/gallery/', ''));
	const object = await env.GALLERY.get(key);
	if (!object) {
		return new Response('Not found', { status: 404 });
	}
	return new Response(object.body, {
		headers: {
			'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'Cache-Control': 'public, max-age=31536000, immutable',
			ETag: object.httpEtag
		}
	});
}

async function uploadImage(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request body' }, 400);
	}

	const dataUrl = body.image;
	const tags = Array.isArray(body.tags) ? body.tags : [];

	if (typeof dataUrl !== 'string') {
		return json({ error: 'Missing image' }, 400);
	}

	const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
	if (!match) {
		return json({ error: 'Image must be a base64 data URL' }, 400);
	}

	const [, mime, base64] = match;
	const extension = MIME_EXTENSIONS[mime];
	if (!extension) {
		return json({ error: `Unsupported image type: ${mime}` }, 400);
	}

	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const date = new Date().toISOString().slice(0, 10);
	const shortId = crypto.randomUUID().slice(0, 8);
	const key = `${date}-${shortId}.${extension}`;

	const cleanTags = tags
		.map((t) => (typeof t === 'string' ? t.trim() : ''))
		.filter(Boolean)
		.join(',');

	await env.GALLERY.put(key, bytes, {
		httpMetadata: { contentType: mime },
		customMetadata: { tags: cleanTags }
	});

	return json({ key, url: `/images/gallery/${key}` }, 201);
}

async function deleteImage(url, env) {
	const key = decodeURIComponent(url.pathname.replace('/api/admin/gallery/', ''));
	await env.GALLERY.delete(key);
	return json({ ok: true });
}

function json(data, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders }
	});
}

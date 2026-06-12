/* ═══════════════════════════════════════════════════════════
   SYNVIA BACKEND — /execute-action endpoint
   Executes approved recommendations from SYNVIA OS with zero
   manual follow-up. Currently supported action types:

     publish_blog → writes + publishes a post to the Wix blog

   PASTE INTO: synvia-backend (same Express file as /send-sms,
   /claude, /update-lead). No new npm packages needed (uses fetch,
   built into Node 18+; Render runs Node 18+ by default).

   ENV VARS to add on Render:
     WIX_API_KEY    = account-level API key (see setup below)
     WIX_SITE_ID    = the site's ID
     WIX_MEMBER_ID  = the Wix member to attribute posts to (author)

   SETUP (one time, ~10 min):
   1. wix.com → log in → click your avatar → Account Settings → API Keys
      → Generate API Key → name it "synvia-os-publisher"
      → Permissions: check "Wix Blog" (All blog permissions) → Create
      → copy the key → WIX_API_KEY
   2. WIX_SITE_ID: open your site's dashboard; the URL looks like
      manage.wix.com/dashboard/<THIS-LONG-UUID>/home — copy the UUID
   3. WIX_MEMBER_ID (post author): in the same dashboard open
      https://manage.wix.com/dashboard/<SITE_ID>/contacts → find the
      site owner contact → the contact/member ID is in the URL when
      opened. (Or call GET https://www.wixapis.com/members/v1/members
      with the API key + site id headers and copy an "id" from the list.)
   4. Add the three env vars on Render → save → auto-redeploy
   5. Approve a recommendation in the OS — post goes live.
═══════════════════════════════════════════════════════════ */

const WIX_API = 'https://www.wixapis.com';

function wixHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': process.env.WIX_API_KEY,
    'wix-site-id': process.env.WIX_SITE_ID,
  };
}

/* Convert the OS's markdown-ish blog body into Wix Ricos rich content.
   Handles: ## / ### headings, "- " bullets (as bulleted paragraphs),
   blank-line-separated paragraphs, **bold** stripped to plain text. */
function toRicos(body) {
  const nodes = [];
  let id = 0;
  const textNode = (text) => ({
    type: 'TEXT', id: '', nodes: [],
    textData: { text, decorations: [] },
  });
  const blocks = String(body).split(/\n\s*\n/);
  for (const raw of blocks) {
    for (const line of raw.split('\n')) {
      const clean = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').trim();
      if (!clean) continue;
      const h = clean.match(/^(#{2,4})\s+(.*)$/);
      if (h) {
        nodes.push({
          type: 'HEADING', id: 'h' + (++id), nodes: [textNode(h[2])],
          headingData: { level: h[1].length },
        });
      } else if (/^[-•]\s+/.test(clean)) {
        nodes.push({
          type: 'PARAGRAPH', id: 'p' + (++id),
          nodes: [textNode('•  ' + clean.replace(/^[-•]\s+/, ''))],
          paragraphData: {},
        });
      } else {
        nodes.push({
          type: 'PARAGRAPH', id: 'p' + (++id), nodes: [textNode(clean)],
          paragraphData: {},
        });
      }
    }
  }
  return { nodes };
}

/* ── Action handlers registry — add new types here ── */
const ACTION_HANDLERS = {

  async publish_blog(payload) {
    const { title, meta, body, tags } = payload || {};
    if (!title || !body) throw new Error('publish_blog needs title and body');
    if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID || !process.env.WIX_MEMBER_ID) {
      throw new Error('Wix credentials not configured on Render (WIX_API_KEY / WIX_SITE_ID / WIX_MEMBER_ID)');
    }

    // 1. Create draft post
    const draftRes = await fetch(`${WIX_API}/blog/v3/draft-posts`, {
      method: 'POST',
      headers: wixHeaders(),
      body: JSON.stringify({
        draftPost: {
          title: String(title).slice(0, 200),
          memberId: process.env.WIX_MEMBER_ID,
          excerpt: (meta || '').slice(0, 500),
          richContent: toRicos(body),
          seoData: meta ? { tags: [
            { type: 'meta', props: { name: 'description', content: meta } },
          ] } : undefined,
        },
        fieldsets: ['URL'],
      }),
    });
    const draftData = await draftRes.json().catch(() => ({}));
    if (!draftRes.ok) {
      throw new Error('Wix draft create failed: ' + (draftData.message || draftRes.status));
    }
    const draftId = draftData.draftPost && draftData.draftPost.id;
    if (!draftId) throw new Error('Wix returned no draft id');

    // 2. Publish it
    const pubRes = await fetch(`${WIX_API}/blog/v3/draft-posts/${draftId}/publish`, {
      method: 'POST',
      headers: wixHeaders(),
      body: JSON.stringify({}),
    });
    const pubData = await pubRes.json().catch(() => ({}));
    if (!pubRes.ok) {
      throw new Error('Wix publish failed: ' + (pubData.message || pubRes.status));
    }

    // Best-effort live URL
    const slug = (draftData.draftPost && draftData.draftPost.url && draftData.draftPost.url.path)
      || (pubData.postId ? null : null);
    const url = (draftData.draftPost && draftData.draftPost.url)
      ? `${draftData.draftPost.url.base || 'https://www.synviajointandspine.com'}${draftData.draftPost.url.path || ''}`
      : 'https://www.synviajointandspine.com/blog';

    return { url, postId: pubData.postId || draftId, tags: tags || '' };
  },

  // Future: ghl_social_post, send_campaign, update_gbp — add here and
  // the OS approve buttons can call them with no frontend changes
  // beyond a new button.
};

app.post('/execute-action', async (req, res) => {
  try {
    const { type, payload } = req.body || {};
    const handler = ACTION_HANDLERS[type];
    if (!handler) {
      return res.status(400).json({ success: false, error: 'Unknown action type: ' + type });
    }
    const result = await handler(payload);
    console.log(`execute-action ✓ ${type}`, result.url || '');
    return res.json({ success: true, type, ...result });
  } catch (err) {
    console.error('execute-action error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

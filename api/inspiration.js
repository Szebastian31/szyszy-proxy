// Vercel Serverless Function — /api/inspiration.js
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
let cache = { at: 0, data: null }
const ALLOWED_ORIGIN = "*" // later: change to "https://szyszy.framer.ai"

const CREATIVE_BOOM_FEEDS = [
  "https://www.creativeboom.com/graphic-design/feed/",
  "https://www.creativeboom.com/feed/",
]
const ITSNICETHAT_FEEDS = [
  "https://www.itsnicethat.com/articles.rss", // working feed (feedburner 404s)
]
const COLOSSAL_FEEDS = [
  "https://www.thisiscolossal.com/category/design/feed/",
  "https://www.thisiscolossal.com/feed/",
]
const BEHANCE_GALLERIES = [
  { key: "illustration",   url: "https://www.behance.net/galleries/illustration" },
  { key: "graphic-design", url: "https://www.behance.net/galleries/graphic-design" },
  { key: "photography",    url: "https://www.behance.net/galleries/photography" },
]
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

function decodeEntities(s = "") {
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
    .replace(/&#0?39;|&apos;/g,"'").replace(/&#x?[0-9a-f]+;/gi," ").trim()
}
function pick(re, str){ const m = re.exec(str); return m ? m[1] : null }

// Fetch an article's og:image (fallback when the feed has no usable image).
async function getOgImage(url){
  try{
    const res = await fetch(url, { headers:{ "User-Agent":UA }})
    if(!res.ok) return null
    const html = await res.text()
    return pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i, html)
        || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i, html)
        || null
  }catch(e){ return null }
}

// Generic RSS reader. If fillImages=true, scrape og:image for items missing one.
async function getRssFeed(feeds, fillImages=false){
  for (const feed of feeds){
    try{
      const res = await fetch(feed, { headers:{ "User-Agent":UA }})
      if(!res.ok) continue
      const xml = await res.text()
      const items = xml.split(/<item>/i).slice(1,12)
      let articles = items.map(block=>({
        title: decodeEntities(pick(/<title>([\s\S]*?)<\/title>/i, block)||""),
        link:  (pick(/<link>([\s\S]*?)<\/link>/i, block)||"").trim(),
        date:  (pick(/<pubDate>([\s\S]*?)<\/pubDate>/i, block)||"").trim(),
        image: pick(/<media:content[^>]*url="([^"]+)"/i, block)
            || pick(/<media:thumbnail[^>]*url="([^"]+)"/i, block)
            || pick(/<enclosure[^>]*url="([^"]+)"/i, block)
            || null,
      })).filter(a=>a.title && a.link).slice(0,6)

      if(fillImages){
        articles = await Promise.all(articles.map(async a =>
          a.image ? a : { ...a, image: await getOgImage(a.link) }
        ))
      }
      if(articles.length) return articles
    }catch(e){}
  }
  return []
}

async function getBehanceGallery({ key, url }){
  try{
    const res = await fetch(url, { headers:{ "User-Agent":UA, "Accept-Language":"en-US,en;q=0.9" }})
    if(!res.ok) return []
    const html = await res.text()
    const seen = new Set(); const projects = []
    const linkRe = /href="(\/gallery\/(\d+)\/[^"?#]+)[^"]*"/g
    let m
    while((m = linkRe.exec(html)) && projects.length < 8){
      const id = m[2]; if(seen.has(id)) continue; seen.add(id)
      const path = m[1]; const slug = path.split("/")[3] || ""
      const title = decodeEntities(slug.replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase()))
      projects.push({ title, link:"https://www.behance.net"+path, image:null, source:key })
    }
    return projects.slice(0,3)
  }catch(e){ return [] }
}
async function getBehance(){
  const all = await Promise.all(BEHANCE_GALLERIES.map(getBehanceGallery))
  return all.flat()
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS")
  if(req.method === "OPTIONS") return res.status(204).end()

  if(cache.data && Date.now()-cache.at < CACHE_TTL_MS){
    res.setHeader("Cache-Control","s-maxage=3600, stale-while-revalidate=86400")
    return res.status(200).json({ ...cache.data, cached:true })
  }
  try{
    const [articles, itsnicethat, colossal, projects] = await Promise.all([
      getRssFeed(CREATIVE_BOOM_FEEDS, true),
      getRssFeed(ITSNICETHAT_FEEDS, true),
      getRssFeed(COLOSSAL_FEEDS, true),
      getBehance(),
    ])
    const data = { articles, itsnicethat, colossal, projects, cachedAt:new Date().toISOString(),
      sources:{ creativeBoom:articles.length, itsnicethat:itsnicethat.length, colossal:colossal.length, behance:projects.length } }
    cache = { at:Date.now(), data }
    res.setHeader("Cache-Control","s-maxage=3600, stale-while-revalidate=86400")
    return res.status(200).json({ ...data, cached:false })
  }catch(e){
    if(cache.data) return res.status(200).json({ ...cache.data, stale:true })
    return res.status(500).json({ error:"Failed to fetch inspiration." })
  }
}

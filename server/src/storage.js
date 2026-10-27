// Supabase Storage adapter. Buckets must be PRIVATE: files are only handed out as short-lived signed links after
// the API has checked that the caller belongs to the class that owns the file.
export async function createSupabaseStorage({ url, serviceKey }) {
  const { createClient } = await import("@supabase/supabase-js");
  const ws = (await import("ws")).default;
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });
  const bucket = name => client.storage.from(name);
  const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };
  return {
    name: "supabase",
    async upload(bucketName, path, buffer, { contentType }) {
      must(await bucket(bucketName).upload(path, buffer, { contentType, upsert: false, cacheControl: "0" }), "upload");
    },
    async remove(bucketName, paths) { if (paths.length) must(await bucket(bucketName).remove(paths), "remove"); },
    async signedUrl(bucketName, path, seconds, downloadName) {
      const data = must(await bucket(bucketName).createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined), "sign");
      return data.signedUrl;
    },
    async download(bucketName, path) {
      const data = must(await bucket(bucketName).download(path), "download");
      return Buffer.from(await data.arrayBuffer());
    },
    async list(bucketName, prefix) {
      const data = must(await bucket(bucketName).list(prefix, { limit: 1000, sortBy: { column: "created_at", order: "desc" } }), "list");
      return data.map(o => ({ name: o.name, size: o.metadata?.size ?? 0, created_at: o.created_at }));
    },
    async isPublic(bucketName) {
      const { data, error } = await client.storage.getBucket(bucketName);
      if (error) return null;
      return Boolean(data?.public);
    },
  };
}

const PROFILE_BUCKET = "company-profile";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

function safeExternalUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

export async function getPublicProfileDocuments(database) {
  const { data, error } = await database.from("profile_docs")
    .select("id,title,description,file_url,storage_path,category,mime_type,media_type,created_at,sort_order,archived_at")
    .eq("is_public", true)
    .is("archived_at", null)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) throw error;

  const documents = await Promise.all((data || []).map(async item => {
    if (item.archived_at) return null;
    let fileUrl = safeExternalUrl(item.file_url);
    if (item.storage_path) {
      const path = String(item.storage_path);
      if (!path || path.startsWith("/") || path.split("/").some(part => part === "..")) return null;
      const { data: signed, error: signError } = await database.storage
        .from(PROFILE_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (signError || !signed?.signedUrl) return null;
      fileUrl = signed.signedUrl;
    }
    if (!fileUrl) return null;
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      category: item.category || "Other",
      mime_type: item.mime_type || "",
      media_type: item.media_type || "document",
      created_at: item.created_at,
      file_url: fileUrl,
    };
  }));

  return documents.filter(Boolean);
}

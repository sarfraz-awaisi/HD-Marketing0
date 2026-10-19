export async function propertyCovers(db, actor, properties) {
  if (!properties.length) return properties;
  const result = await db.rpc("property_cover_photos", {
    p_actor: actor,
    p_properties: properties.map((property) => property.id),
  });
  // Older installations retain the individual photo requests until 027 is applied.
  if (["PGRST202", "42883"].includes(result.error?.code)) return properties;
  if (result.error)
    throw Object.assign(new Error("Property pictures could not be loaded."), {
      status: result.error.code === "42501" ? 403 : 503,
    });
  const photos = result.data || [];
  let urls = [];
  if (photos.length) {
    const signed = await db.storage.from("property-photos").createSignedUrls(
      photos.map((photo) => photo.storage_path),
      60,
    );
    if (!signed.error) urls = signed.data || [];
  }
  const covers = new Map(
    photos.map((photo, index) => [
      photo.property_id,
      {
        photo_count: Number(photo.photo_count),
        cover_photo: { id: photo.id, url: urls[index]?.signedUrl || null },
      },
    ]),
  );
  return properties.map((property) => ({
    ...property,
    ...(covers.get(property.id) || { photo_count: 0, cover_photo: null }),
  }));
}

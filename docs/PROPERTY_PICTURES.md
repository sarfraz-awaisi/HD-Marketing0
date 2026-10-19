# Pictures while adding or editing a property

In the administrator portal, open **Properties → Add property**. Fill in the property details, then use **Add pictures** to choose one or several JPG, PNG or WebP files. Each picture must be nonempty and no larger than 5 MB. Pictures are optional.

Selected pictures appear as previews with their filenames. Use **Remove picture** to omit a picture before saving, or **Add pictures** again to select more. Re-selecting the same filename, size and modification time does not add another copy to the selection. Unsupported, empty or oversized files are skipped with a message; valid selections remain available.

Click **Save record** to save the property and upload the selected pictures. The form stays open and cannot be dismissed during saving; fields, picker and removal buttons are disabled until the request completes. On success, the saved property's gallery opens and shows its pictures. Saving with no pictures preserves the previous save-and-close behavior.

The same picker is available in **Edit property**. Existing pictures remain in the property's gallery, where administrators can upload more or delete individual pictures. Agents can view saved pictures and cannot create, upload or delete them.

## Cards and property details

In both portals, each property card shows a saved picture when available, with its availability and property type over the picture. Cards with multiple pictures show the photo count. Properties without pictures show **No pictures added**. The card also shows the title, location, price and area.

Click the picture or **View property** to open the full details: price, availability, location, property type, area, description and all uploaded pictures. The picture control also works with keyboard navigation. Administrators have the existing edit, archive, delete and photo controls; agents can read the same details and view the pictures.

Cards and the gallery share the photo cache. Uploading or deleting a picture updates both views; removing the cover uses the next available picture. Images fit the card without stretching. If a picture cannot load, the card shows **Picture unavailable** and the details remain accessible.

## Failed uploads

If the property itself fails to save, its inputs and selected pictures remain in the form, and no pictures are uploaded. If a later picture fails after the property was saved, the error explains that the property exists. Successful picture responses remove those pictures from the pending selection. Click **Save record** again to update the same property and retry the remaining pictures, without creating a second property. Closing the form after an upload failure keeps the saved property and any completed uploads; unsaved selections are discarded.

## Implementation and setup

`PropertyPhotoPicker.jsx` provides the accessible multi-file picker, local validation, previews and removal. Preview object URLs are released when a picture leaves the selection or the form closes. `PropertyForm.jsx` keeps selected files outside the property JSON payload. `Properties.jsx` saves metadata before uploading each picture through the existing multipart `POST /api/properties/:id/photos` route and retains the created ID for retries.

The shared record form supports optional extra content and disables fields while submitting. `PropertyCard.jsx` displays the cover through the existing authorized photo endpoint, while `PropertyDetails.jsx` displays the shared property information. `usePropertyPhotos.js` provides their shared query cache. The open gallery renews its 60-second signed URLs every 45 seconds and updates the corresponding card through that cache. Loaded card pictures do not poll individually. A card retries a failed image URL once by requesting fresh photo metadata, which also handles a lazy-loaded URL expiring before the picture is scrolled into view. Failed retries remain a readable placeholder.

The existing photo API continues to require an active administrator for uploads, enforce the 5 MB upload limit and check image signatures against MIME types. Both active roles can read pictures. Pictures remain in the private `property-photos` bucket and are displayed through short-lived signed URLs.

This change needs no new SQL migration or dependency. The previously installed CRM schema and Storage bucket are used. Local checks use isolated records and storage; no hosted property or photo is created during verification.

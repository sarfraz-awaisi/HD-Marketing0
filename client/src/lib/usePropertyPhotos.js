import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function usePropertyPhotos(
  propertyId,
  { refresh = true, enabled = true } = {},
) {
  return useQuery({
    queryKey: ["photos", propertyId],
    queryFn: ({ signal }) =>
      api(`/properties/${propertyId}/photos`, { signal }),
    enabled: !!propertyId && enabled,
    staleTime: 45000,
    refetchInterval: refresh ? 45000 : false,
  });
}

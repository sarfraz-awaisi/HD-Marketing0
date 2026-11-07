// Lead temperature (update 052): Hot, Warm or Cold, chosen by the agent
// after speaking to the customer and saved as a tag with that call. A lead's
// temperature is the latest one saved; earlier calls keep theirs.
export const temperatures = [
  { value: "hot", tag: "Hot lead", label: "Hot", emoji: "🔥" },
  { value: "warm", tag: "Warm lead", label: "Warm", emoji: "🌤️" },
  { value: "cold", tag: "Cold lead", label: "Cold", emoji: "❄️" },
];
export const temperatureTags = temperatures.map((t) => t.tag);
// By value ("hot") or by tag ("Hot lead").
export const temperatureOf = (value) =>
  temperatures.find((t) => t.value === value || t.tag === value) || null;
export const temperatureText = (value) => {
  const t = temperatureOf(value);
  return t ? `${t.emoji} ${t.label}` : "Not recorded";
};
// The temperature among a call's tags, and the tags that are not one.
export const tagTemperature = (tags = []) =>
  temperatures.find((t) => tags.includes(t.tag))?.value || "";
export const otherTags = (tags = []) =>
  tags.filter((tag) => !temperatureTags.includes(tag));

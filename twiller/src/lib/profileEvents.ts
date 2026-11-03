/**
 * Cross-component navigation events (no router is used in this app).
 *
 * Twiller switches views with `currentPage` state inside Mainlayout. Some flows
 * - e.g. the language-switch OTP dialog telling the user they must add a phone
 * number first - need to send the user to another view. Dispatching/observing
 * this event keeps that navigation working without threading props through
 * every intermediate component.
 */
export const OPEN_PROFILE_EDIT_EVENT = "twiller:open-profile-edit";
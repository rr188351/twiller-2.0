import { useAuth } from "@/context/AuthContext";
import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Camera, LinkIcon, MapPin, X, Phone } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import LoadingSpinner from "./loading-spinner";
// Image uploads now go through Twiller's OWN authenticated backend endpoint
// instead of a hardcoded third-party (imgbb) API key.
import {
  uploadImage,
  MAX_IMAGE_SIZE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
} from "@/lib/uploadImage";
// Internship Feature 4 (phase 1) - localized strings.
import { useLanguage } from "@/context/LanguageContext";

// Internship Feature 4 (phase 2) - country dial codes offered in the profile
// form. The digits are what gets prepended to the national number before it is
// sent to the backend, which stores ONLY digits (e.g. "+91 98765 43210" ->
// "919876543210"). Keep this list to codes the mentors' locales actually use.
const DIAL_CODES = [
  "+91", "+1", "+44", "+61", "+971", "+49", "+33", "+34", "+351",
  "+55", "+86", "+81", "+65", "+7", "+27", "+880", "+92", "+94", "+977",
];
const DEFAULT_DIAL_CODE = "+91";

/** Splits a stored digits-only phone back into { dialCode, national }. */
function splitStoredPhone(stored: string): { dialCode: string; national: string } {
  const digits = String(stored || "").replace(/\D/g, "");
  if (!digits) return { dialCode: DEFAULT_DIAL_CODE, national: "" };
  // Longest-prefix match, so a 3-digit code can never lose to "+1"/"+7".
  const candidates = DIAL_CODES.map((c) => ({ dialCode: c, code: c.replace(/\D/g, "") }))
    .filter((c) => digits.startsWith(c.code))
    .sort((a, b) => b.code.length - a.code.length);
  if (candidates.length) {
    const { dialCode, code } = candidates[0];
    return { dialCode, national: digits.slice(code.length) };
  }
  return { dialCode: DEFAULT_DIAL_CODE, national: digits };
}

const Editprofile = ({ isopen, onclose }: any) => {
  const { user, updateProfile } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormdata] = useState({
    displayName: user?.displayName || "",
    bio: user?.bio || "",
    location: "Earth",
    website: "example.com",
    avatar: user?.avatar || "",
    // Normalised digits (dial code + national number). "" = no phone on file.
    phone: "",
  });
  const [error, setError] = useState<any>({});
  const [uploadError, setUploadError] = useState("");
  // Internship Feature 4 (phase 2) - phone number split into dial code +
  // national number. `formData.phone` always carries the NORMALISED digits the
  // backend writes, so the language-switch SMS flow can use it immediately.
  const [dialCode, setDialCode] = useState(DEFAULT_DIAL_CODE);
  const [phoneNational, setPhoneNational] = useState("");
  // Internship Feature 4 (phase 1).
  const { t } = useLanguage();

  // Re-sync the form from the server profile whenever the modal opens; the
  // useState initialiser above only ever ran on the very first mount.
  useEffect(() => {
    if (!isopen || !user) return;
    const parsed = splitStoredPhone(user.phone || "");
    setDialCode(parsed.dialCode);
    setPhoneNational(parsed.national);
    setFormdata((prev) => ({
      ...prev,
      phone: parsed.national ? parsed.dialCode.replace(/\D/g, "") + parsed.national : "",
    }));
    setError({});
    setUploadError("");
  }, [isopen, user]);

  if (!isopen || !user) return null;
  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.displayName.trim()) {
      newErrors.displayName = t("editProfile.errDisplayNameRequired");
    } else if (formData.displayName.length > 50) {
      newErrors.displayName = t("editProfile.errDisplayNameLong");
    }

    if (formData.bio.length > 160) {
      newErrors.bio = t("editProfile.errBioLong");
    }

    if (formData.website && formData.website.length > 100) {
      newErrors.website = t("editProfile.errWebsiteLong");
    }

    if (formData.location && formData.location.length > 30) {
      newErrors.location = t("editProfile.errLocationLong");
    }

    // Internship Feature 4 (phase 2): a typed national number must combine with
    // the dial code into a plausible E.164-ish value (>= 7 digits). Leaving it
    // blank is allowed and clears the stored number.
    const combinedDigits = `${dialCode}${phoneNational}`.replace(/\D/g, "");
    if (phoneNational && combinedDigits.length < 7) {
      newErrors.phone = t("phone.errInvalid");
    }

    setError(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  /** Updates the dial code + national number and keeps formData.phone in sync. */
  const applyPhone = (nextDialCode: string, nextNational: string) => {
    const nationalDigits = String(nextNational || "").replace(/\D/g, "");
    setDialCode(nextDialCode);
    setPhoneNational(nationalDigits);
    setFormdata((prev) => ({
      ...prev,
      phone: nationalDigits ? nextDialCode.replace(/\D/g, "") + nationalDigits : "",
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm() || isLoading) return;

    setIsLoading(true);
    try {
      // Send the normalised phone explicitly so the backend's normalisation and
      // duplicate check always see the fully-qualified number.
      const payload = {
        ...formData,
        phone: phoneNational
          ? `${dialCode.replace(/\D/g, "")}${phoneNational}`
          : "",
      };
      await updateProfile(payload);
      onclose();
    } catch (err: any) {
      const message = String(err?.message || "");
      if (/phone number is already used/i.test(message)) {
        setError({ general: t("phone.errTaken") });
      } else {
        setError({ general: message || t("editProfile.errSaveFailed") });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormdata((prev) => ({ ...prev, [field]: value }));
    if (error[field]) {
      setError((prev: any) => ({ ...prev, [field]: "" }));
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const image = e.target.files[0];
    setUploadError("");
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(image.type)) {
      setUploadError(t("upload.imageBadType"));
      e.target.value = "";
      return;
    }
    if (image.size > MAX_IMAGE_SIZE_BYTES) {
      setUploadError(t("upload.imageTooLarge"));
      e.target.value = "";
      return;
    }
    setIsLoading(true);
    try {
      const { url } = await uploadImage(image);
      if (url) {
        setFormdata((prev) => ({ ...prev, avatar: url }));
      }
    } catch {
      setUploadError(t("upload.imageFailed"));
    } finally {
      setIsLoading(false);
      e.target.value = "";
    }
  };
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-2xl bg-black border-gray-800 text-white max-h-[90vh] overflow-y-auto">
        <CardHeader className="relative pb-4 border-b border-gray-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                size="icon"
                className="text-white bg-black hover:bg-gray-900"
                onClick={onclose}
                disabled={isLoading}
              >
                <X className="h-5 w-5" />
              </Button>
              <CardTitle className="text-xl font-bold">Edit profile</CardTitle>
            </div>
            <Button
              type="submit"
              form="edit-profile-form"
              className="bg-white text-black hover:bg-gray-200 font-semibold rounded-full px-6"
              disabled={isLoading}
            >
              {isLoading ? (
                <div className="flex items-center space-x-2">
                  <LoadingSpinner size="sm" />
                  <span>{t("editProfile.saving")}</span>
                </div>
              ) : (
                t("editProfile.save")
              )}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {error.general && (
            <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm m-4">
              {error.general}
            </div>
          )}
          {uploadError && (
            <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm m-4">
              {uploadError}
            </div>
          )}

          <form id="edit-profile-form" onSubmit={handleSubmit}>
            {/* Cover Photo */}
            <div className="relative">
              <div className="h-48 bg-gradient-to-r from-blue-600 to-purple-600 relative">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 p-3 rounded-full bg-black/70 hover:bg-black/90"
                  disabled={isLoading}
                >
                  <Camera className="h-6 w-6 text-white" />
                </Button>
              </div>

              {/* Profile Picture */}
              <div className="absolute -bottom-16 left-4">
                <div className="relative">
                  <Avatar className="h-32 w-32 border-4 border-black">
                    <AvatarImage src={formData.avatar || user?.avatar} alt={user?.displayName} />
                    <AvatarFallback className="text-2xl">
                      {user?.displayName?.[0]}
                    </AvatarFallback>
                  </Avatar>
                  <input
                    type="file"
                    accept="image/*"
                    id="avatarUpload"
                    className="hidden"
                    onChange={handlePhotoUpload}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 p-3 rounded-full bg-black/70 hover:bg-black/90"
                    disabled={isLoading}
                    onClick={() =>
                      document.getElementById("avatarUpload")?.click()
                    }
                  >
                    <Camera className="h-5 w-5 text-white" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="p-4 mt-16 space-y-6">
              {/* Display Name */}
              <div className="space-y-2">
                <Label htmlFor="displayName" className="text-white">
                  Name
                </Label>
                <Input
                  id="displayName"
                  type="text"
                  value={formData.displayName}
                  onChange={(e) =>
                    handleInputChange("displayName", e.target.value)
                  }
                  className="bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500"
                  placeholder="Your display name"
                  maxLength={50}
                  disabled={isLoading}
                />
                <div className="flex justify-between text-sm">
                  {error.displayName && (
                    <p className="text-red-400">{error.displayName}</p>
                  )}
                  <p className="text-gray-400 ml-auto">
                    {formData.displayName.length}/50
                  </p>
                </div>
              </div>

              {/* Bio */}
              <div className="space-y-2">
                <Label htmlFor="bio" className="text-white">
                  Bio
                </Label>
                <Textarea
                  id="bio"
                  value={formData.bio}
                  onChange={(e) => handleInputChange("bio", e.target.value)}
                  className="bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500 resize-none min-h-[100px]"
                  placeholder="Tell the world about yourself"
                  maxLength={160}
                  disabled={isLoading}
                />
                <div className="flex justify-between text-sm">
                  {error.bio && <p className="text-red-400">{error.bio}</p>}
                  <p className="text-gray-400 ml-auto">
                    {formData.bio.length}/160
                  </p>
                </div>
              </div>

              {/* Location */}
              <div className="space-y-2">
                <Label htmlFor="location" className="text-white">
                  Location
                </Label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                  <Input
                    id="location"
                    type="text"
                    value={formData.location}
                    onChange={(e) =>
                      handleInputChange("location", e.target.value)
                    }
                    className="pl-10 bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500"
                    placeholder="Where are you located?"
                    maxLength={30}
                    disabled={isLoading}
                  />
                </div>
                <div className="flex justify-between text-sm">
                  {error.location && (
                    <p className="text-red-400">{error.location}</p>
                  )}
                  <p className="text-gray-400 ml-auto">
                    {formData.location.length}/30
                  </p>
                </div>
              </div>

              {/* Website */}
              <div className="space-y-2">
                <Label htmlFor="website" className="text-white">
                  Website
                </Label>
                <div className="relative">
                  <LinkIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                  <Input
                    id="website"
                    type="text"
                    value={formData.website}
                    onChange={(e) =>
                      handleInputChange("website", e.target.value)
                    }
                    className="pl-10 bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500"
                    placeholder="Your website URL"
                    maxLength={100}
                    disabled={isLoading}
                  />
                </div>
                <div className="flex justify-between text-sm">
                  {error.website && (
                    <p className="text-red-400">{error.website}</p>
                  )}
                  <p className="text-gray-400 ml-auto">
                    {formData.website.length}/100
                  </p>
                </div>
              </div>

              {/* Internship Feature 4 (phase 2) - phone number used for the
                  language-switch SMS codes. Stored digits-only. */}
              <div className="space-y-2">
                <Label htmlFor="phone" className="text-white">
                  {t("phone.label")}
                </Label>
                <div className="flex gap-2">
                  <select
                    aria-label={t("phone.dialCode")}
                    value={dialCode}
                    onChange={(e) => applyPhone(e.target.value, phoneNational)}
                    disabled={isLoading}
                    className="h-9 rounded-md border border-gray-600 bg-black text-white text-sm px-2 outline-none focus:border-blue-500"
                  >
                    {DIAL_CODES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                  <div className="relative flex-1">
                    <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                    <Input
                      id="phone"
                      type="tel"
                      inputMode="tel"
                      value={phoneNational}
                      onChange={(e) => applyPhone(dialCode, e.target.value)}
                      className="pl-10 bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500"
                      placeholder={t("phone.placeholder")}
                      maxLength={15}
                      disabled={isLoading}
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500">{t("phone.hint")}</p>
                {error.phone && (
                  <p className="text-red-400 text-sm">{error.phone}</p>
                )}
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default Editprofile;

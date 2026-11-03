import { useAuth } from "@/context/AuthContext";
import React, { useState } from "react";
import { Card, CardContent } from "./ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { Image, Smile, Calendar, MapPin, BarChart3, Globe, Music, X } from "lucide-react";
import { Separator } from "./ui/separator";
import axiosInstance from "@/lib/axiosInstance";
// Internship Feature 4 (phase 1) - localized strings.
import { useLanguage } from "@/context/LanguageContext";
// Image uploads now go through Twiller's OWN authenticated backend endpoint
// instead of a hardcoded third-party (imgbb) API key.
import {
  uploadImage,
  MAX_IMAGE_SIZE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
} from "@/lib/uploadImage";
// Internship Feature 5 - audio tweet upload dialog.
import AudioUploadDialog from "./AudioUploadDialog";

const TweetComposer = ({ onTweetPosted, onAudioPosted }: any) => {
  const { user } = useAuth();
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [imageurl, setimageurl] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [audioOpen, setAudioOpen] = useState(false);
  const maxLength = 200;
  // Internship Feature 4 (phase 1).
  const { t } = useLanguage();
  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if(!user || !content.trim())return
    try {
      const tweetdata={
        author:user?._id,
        content,
        image:imageurl
      }
      const res=await axiosInstance.post('/post',tweetdata)
      onTweetPosted(res.data)
      setContent("")
      setimageurl("")
    } catch (error) {
      console.log(error)
    }finally{
      setIsLoading(false)
    }
  };

  const characterCount = content.length;
  const isOverLimit = characterCount > maxLength;
  const isNearLimit = characterCount > maxLength * 0.8;
  if (!user) return null;
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const image = e.target.files[0];
    setUploadError("");
    // Client-side mirror of the server rules (type + 5 MB).
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
      if (url) setimageurl(url);
    } catch {
      setUploadError(t("upload.imageFailed"));
    } finally {
      setIsLoading(false);
      e.target.value = "";
    }
  };
  return (
    <>
    <Card className="bg-black border-gray-800 border-x-0 border-t-0 rounded-none">
      <CardContent className="p-4">
        <div className="flex space-x-4">
          <Avatar className="h-12 w-12">
            <AvatarImage src={user.avatar} alt={user.displayName} />
            <AvatarFallback>{user.displayName[0]}</AvatarFallback>
          </Avatar>

          <div className="flex-1">
            <form onSubmit={handleSubmit}>
              <Textarea
                placeholder={t("composer.placeholder")}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="bg-transparent border-none text-xl text-white placeholder-gray-500 resize-none min-h-[120px] focus-visible:ring-0 focus-visible:ring-offset-0"
              />

              {/* Chosen image preview (uploaded via Twiller's backend). */}
              {imageurl && (
                <div className="relative mb-3 rounded-2xl overflow-hidden border border-gray-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageurl}
                    alt=""
                    className="w-full h-auto max-h-72 object-cover"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("upload.imageRemove")}
                    className="absolute right-2 top-2 bg-black/60 text-white hover:bg-black/80"
                    onClick={() => setimageurl("")}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}
              {isLoading && imageurl === "" && (
                <p className="text-sm text-gray-400">{t("upload.imageUploading")}</p>
              )}
              {uploadError && (
                <p className="text-sm text-red-400">{uploadError}</p>
              )}

              <div className="flex items-center justify-between mt-4">
                <div className="flex items-center space-x-4 text-blue-400">
                  <label
                    htmlFor="tweetImage"
                    className="p-2 rounded-full hover:bg-blue-900/20 cursor-pointer"
                  >
                    <Image className="h-5 w-5" />
                    <input
                      type="file"
                      accept="image/*"
                      id="tweetImage"
                      className="hidden"
                      onChange={handlePhotoUpload}
                      disabled={isLoading}
                    />
                  </label>
                  {/* Internship Feature 5 - open the audio tweet dialog. */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("upload.audioTitle")}
                    title={t("upload.audioTitle")}
                    className="p-2 rounded-full hover:bg-blue-900/20"
                    onClick={() => setAudioOpen(true)}
                    disabled={isLoading}
                  >
                    <Music className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="p-2 rounded-full hover:bg-blue-900/20"
                  >
                    <BarChart3 className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="p-2 rounded-full hover:bg-blue-900/20"
                  >
                    <Smile className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="p-2 rounded-full hover:bg-blue-900/20"
                  >
                    <Calendar className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="p-2 rounded-full hover:bg-blue-900/20"
                  >
                    <MapPin className="h-5 w-5" />
                  </Button>
                </div>
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <Globe className="h-4 w-4 text-blue-400" />
                    <span className="text-sm text-blue-400 font-semibold">
                      {t("composer.replyScope")}
                    </span>
                  </div>
                  <div className="flex items-center space-x-3">
                    {characterCount > 0 && (
                      <div className="flex items-center space-x-2">
                        <div className="relative w-8 h-8">
                          <svg className="w-8 h-8 transform -rotate-90">
                            <circle
                              cx="16"
                              cy="16"
                              r="14"
                              stroke="currentColor"
                              strokeWidth="2"
                              fill="none"
                              className="text-gray-700"
                            />
                            <circle
                              cx="16"
                              cy="16"
                              r="14"
                              stroke="currentColor"
                              strokeWidth="2"
                              fill="none"
                              strokeDasharray={`${2 * Math.PI * 14}`}
                              strokeDashoffset={`${
                                2 *
                                Math.PI *
                                14 *
                                (1 - characterCount / maxLength)
                              }`}
                              className={
                                isOverLimit
                                  ? "text-red-500"
                                  : isNearLimit
                                  ? "text-yellow-500"
                                  : "text-blue-500"
                              }
                            />
                          </svg>
                        </div>
                        {isNearLimit && (
                          <span
                            className={`text-sm ${
                              isOverLimit ? "text-red-500" : "text-yellow-500"
                            }`}
                          >
                            {maxLength - characterCount}
                          </span>
                        )}
                      </div>
                    )}
                    <Separator
                      orientation="vertical"
                      className="h-6 bg-gray-700"
                    />

                    <Button
                      type="submit"
                      disabled={!content.trim() || isOverLimit|| isLoading}
                      className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-full px-6"
                    >
                      {t("composer.post")}
                    </Button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      </CardContent>
    </Card>
      <AudioUploadDialog
        isOpen={audioOpen}
        onClose={() => setAudioOpen(false)}
        onPosted={(tweet: any) =>
          onAudioPosted ? onAudioPosted(tweet) : onTweetPosted?.(tweet)
        }
      />
    </>
  );
};

export default TweetComposer;

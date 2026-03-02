import React, { useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { Chip, Paper } from "@material-ui/core";
import VideocamRoundedIcon from "@material-ui/icons/VideocamRounded";
import YouTubeIcon from "@material-ui/icons/YouTube";
import PhotoSizeSelectActualIcon from "@material-ui/icons/PhotoSizeSelectActual";
import CreateIcon from "@material-ui/icons/Create";
// Colors import removed — using green branding directly
import Styles from "./Style";
import swal from "@sweetalert/with-react";
import InsertLinkIcon from "@material-ui/icons/InsertLink";
import HighlightOffIcon from "@material-ui/icons/HighlightOff";
import { imageUploadHandler } from "./form.utils";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";

const MAX_POST_IMAGES = 4;

const Form = () => {
  const classes = Styles();
  const createPost = useMutation(api.posts.createPost);
  const generateImageUploadUrl = useMutation(api.posts.generateImageUploadUrl);
  const { isAuthenticated } = useConvexAuth();
  const user = useConvexUser();

  const [uploadData, setUploadData] = useState({
    description: "",
    files: [],
  });

  const [openURL, setOpenURL] = useState(false);
  const [URL, setURL] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmitButton = async (e) => {
    e.preventDefault();

    if (isSubmitting) {
      return;
    }

    const description = uploadData.description.trim();

    if (!description && uploadData.files.length === 0 && !URL) {
      swal("Empty Post", "Please enter something","warning");
      return;
    }

    if (!user?._id) {
      swal("Please wait", "User profile is still loading.", "warning");
      return;
    }

    if (URL !== "") {
      if (URL.startsWith("data")) {
        swal("Invalid Image URL", "DATA-URL format is not allowed","warning");
        setURL("");
        return;
      }

      if (URL.includes("youtu.be") || URL.includes("youtube")) {
        swal("Invalid Image URL","Youtube videos are not allowed","warning");
        setURL("");
        return;
      }

      if (!URL.startsWith("http")) {
        swal("Invalid Image URL","Please enter valid image url","warning");
        setURL("");
        return;
      }
    }

    try {
      setIsSubmitting(true);

      const payload = {
        authorId: user._id,
        description,
      };

      const selectedFiles = uploadData.files;
      const selectedImageFiles = selectedFiles.filter(
        (file) => file.type === "image" && Boolean(file.blob),
      );

      if (selectedImageFiles.length > 0 && !URL) {
        const uploadedStorageIds = await Promise.all(
          selectedImageFiles.map(async (file) => {
            const uploadUrl = await generateImageUploadUrl({});
            const uploadResponse = await fetch(uploadUrl, {
              method: "POST",
              headers: {
                "Content-Type": file.blob.type || "application/octet-stream",
              },
              body: file.blob,
            });

            if (!uploadResponse.ok) {
              throw new Error("Image upload failed");
            }

            const uploadResult = await uploadResponse.json();
            if (!uploadResult.storageId) {
              throw new Error("Missing uploaded image storage ID");
            }

            return uploadResult.storageId;
          }),
        );

        payload.imageStorageIds = uploadedStorageIds;
      } else {
        const selectedFile = selectedFiles[0];
        const fileType = URL ? "image" : selectedFile?.type || undefined;
        const fileData = URL || selectedFile?.data || undefined;
        if (fileType) {
          payload.fileType = fileType;
        }
        if (fileData) {
          payload.fileData = fileData;
        }
      }

      await createPost(payload);
      resetState();
      swal({
        icon: "success",
        title: "Post created!",
        timer: 1500,
        buttons: false,
      });
    } catch (error) {
      console.error("Failed to create post:", error);
      swal("Post Failed", "Unable to publish your post right now.", "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetState = () => {
    setUploadData({
      description: "",
      files: [],
    });
    setOpenURL(false);
    setURL("");
  };

  const handleRemoveFile = (indexToRemove) => {
    setUploadData((previousValue) => ({
      ...previousValue,
      files: previousValue.files.filter((_, fileIndex) => fileIndex !== indexToRemove),
    }));
  };

  const toggleURL_Tab = () => {
    if (uploadData.files.length > 0) {
      setOpenURL(false);
    } else if (URL === "") {
      setOpenURL(!openURL);
    } else {
      setOpenURL(true);
    }
  };

  const closeURL_Tab = () => {
    if (URL === "") {
      setOpenURL(false);
    } else {
      setOpenURL(true);
    }
  };

  if (!isAuthenticated || !user?._id) {
    return null;
  }

  return (
    <Paper className={classes.upload}>
      <div className={classes.upload__header}>
        <form className={classes.header__form} onSubmit={handleSubmitButton}>
          <CreateIcon />
          <input
            placeholder="Start a post"
            value={uploadData.description}
            onChange={(e) => setUploadData({ ...uploadData, description: e.target.value })}
          />
          <input
            id="upload-image"
            type="file"
            accept="image/*"
            hidden
            multiple
            onChange={(e) => {
              imageUploadHandler(e, "image", setUploadData, { maxImageCount: MAX_POST_IMAGES });
              setOpenURL(false);
              setURL("");
            }}
          />
          <input
            id="upload-video"
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              imageUploadHandler(e, "video", setUploadData);
              setOpenURL(false);
            }}
          />
          <button type="submit" disabled={isSubmitting}>{isSubmitting ? "Posting..." : "Post"}</button>
        </form>
      </div>
      {!openURL && uploadData.files.length > 0 && (
        <div className={classes.selectedFile}>
          {uploadData.files.map((file, fileIndex) => (
            <Chip
              key={`${file.name}-${fileIndex}`}
              color="primary"
              size="small"
              onDelete={() => handleRemoveFile(fileIndex)}
              icon={
                file.type === "image" ? (
                  <PhotoSizeSelectActualIcon />
                ) : (
                  <VideocamRoundedIcon />
                )
              }
              label={file.name}
            />
          ))}
        </div>
      )}
      {openURL && (
        <div className={classes.pasteURL_Input}>
          <InsertLinkIcon />
          <input
            placeholder="Paste an image URL"
            value={URL}
            onChange={(e) => setURL(e.target.value)}
          />
          {URL !== "" && (
            <HighlightOffIcon
              style={{ color: "orange", fontSize: 16 }}
              onClick={() => setURL("")}
            />
          )}
        </div>
      )}

      <div className={classes.upload__media}>
        <label
          htmlFor={URL === "" ? "upload-image" : ""}
          onClick={closeURL_Tab}
          className={classes.media__options}
        >
          <PhotoSizeSelectActualIcon
            style={{ color: "#2e7d32" }}
          />
          <h4>Photo</h4>
        </label>
        <label
          htmlFor={URL === "" ? "upload-video" : ""}
          onClick={closeURL_Tab}
          className={classes.media__options}
        >
          <YouTubeIcon style={{ color: "orange" }} />
          <h4>Video</h4>
        </label>
        <div className={classes.media__options} onClick={toggleURL_Tab}>
          <InsertLinkIcon style={{ color: "#e88ee4", fontSize: 30 }} />
          <h4>URL</h4>
        </div>
      </div>
    </Paper>
  );
};

export default Form;

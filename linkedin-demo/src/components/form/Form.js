import React, { useState } from "react";
import { useMutation } from "convex/react";
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

const Form = () => {
  const classes = Styles();
  const createPost = useMutation(api.posts.createPost);
  const featuredUser = useConvexUser();

  const [uploadData, setUploadData] = useState({
    description: "",
    file: {
      type: "",
      name: "",
      data: "",
    },
  });

  const [openURL, setOpenURL] = useState(false);
  const [URL, setURL] = useState("");

  const handleSubmitButton = async (e) => {
    e.preventDefault();
    const description = uploadData.description.trim();

    if (!description && !uploadData.file.data && !URL) {
      swal("Empty Post", "Please enter something","warning");
      return;
    }

    if (!featuredUser?._id) {
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

    const fileType = URL ? "image" : uploadData.file.type || undefined;
    const fileData = URL || uploadData.file.data || undefined;

    try {
      await createPost({
        authorId: featuredUser._id,
        description,
        ...(fileType ? { fileType } : {}),
        ...(fileData ? { fileData } : {}),
      });
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
    }
  };

  const resetState = () => {
    setUploadData({
      description: "",
      file: {
        type: "",
        name: "",
        data: "",
      },
    });
    setOpenURL(false);
    setURL("");
  };

  const toggleURL_Tab = () => {
    if (uploadData.file.data !== "") {
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
            onChange={(e) => {
              imageUploadHandler(e, "image", uploadData, setUploadData);
              setOpenURL(false);
            }}
          />
          <input
            id="upload-video"
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              imageUploadHandler(e, "video", uploadData, setUploadData);
              setOpenURL(false);
            }}
          />
          <button type="submit">Post</button>
        </form>
      </div>
      {!openURL && uploadData.file.name && (
        <div className={classes.selectedFile}>
          <Chip
            color="primary"
            size="small"
            onDelete={resetState}
            icon={
              uploadData.file.type === "image" ? (
                <PhotoSizeSelectActualIcon />
              ) : (
                <VideocamRoundedIcon />
              )
            }
            label={uploadData.file.name}
          />
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

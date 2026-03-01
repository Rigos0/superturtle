import React, { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { Paper, Avatar, Divider } from "@material-ui/core";
import LabelImportantIcon from "@material-ui/icons/LabelImportant";
import Style from "./Style";

const SidebarTop = () => {
  const classes = Style();
  const { photoURL, displayName } = useSelector((state) => state.user);
  const [viewed, setViewed] = useState(1);
  const [connections, setConnections] = useState(1);

  useEffect(() => {
    setViewed(Math.floor(Math.random() * 100));
    setConnections(Math.floor(Math.random() * 1000));
  }, []);

  return (
    <Paper className={classes.sidebar}>
      <div
        className={classes.cover}
        style={{
          backgroundImage: `url("https://tandsgo.com/wp-content/uploads/2020/02/Abstract-blue-and-orange-pattern.jpg")`,
        }}
      ></div>
      <Avatar src={photoURL} />
      <h4>{displayName}</h4>
      <div className={classes.stats}>
        <Divider />
        <div className={classes.stat}>
          <h4>Who viewed your profile</h4>
          <p>{viewed}</p>
        </div>
        <div className={classes.stat}>
          <h4>Connections</h4>
          <p>{connections}</p>
        </div>
        <Divider />
      </div>
      <div className={classes.myItems}>
        <LabelImportantIcon style={{ transform: "rotate(-90deg)" }} />
        <h4>My Items</h4>
      </div>
    </Paper>
  );
};

export default SidebarTop;

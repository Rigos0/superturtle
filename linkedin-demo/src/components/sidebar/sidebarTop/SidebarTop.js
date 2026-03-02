import React from "react";
import { Paper, Avatar, Divider } from "@material-ui/core";
import LabelImportantIcon from "@material-ui/icons/LabelImportant";
import useConvexUser from "../../../hooks/useConvexUser";
import Style from "./Style";

const SidebarTop = () => {
  const classes = Style();
  const user = useConvexUser();
  const connections = user?.connections ?? 0;

  return (
    <Paper className={classes.sidebar}>
      <div
        className={classes.cover}
        style={{
          backgroundImage: "linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%)",
        }}
      ></div>
      <Avatar src={user?.photoURL} />
      <h4>{user?.displayName ?? "Guest User"}</h4>
      <p className={classes.subtitle}>{user?.title ?? "TurtleIn member"}</p>
      <div className={classes.stats}>
        <Divider />
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

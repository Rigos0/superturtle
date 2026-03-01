import React from "react";
import ArrowDropDownIcon from "@material-ui/icons/ArrowDropDown";
import { Hidden } from "@material-ui/core";
import Style from "./Style";

const MenuItem = ({ Icon, title, arrow, onClick }) => {
  const classes = Style();
  return (
    <div className={classes.menuItem} onClick={onClick}>
      {Icon}
      <Hidden mdDown>
        <div className={classes.title}>
          <p>{title}</p>
          {arrow && <ArrowDropDownIcon />}
        </div>
      </Hidden>
    </div>
  );
};

export default MenuItem;

import React, { useState } from "react";
import { Paper } from "@material-ui/core";
import FiberManualRecordIcon from "@material-ui/icons/FiberManualRecord";
import ErrorOutlineSharpIcon from "@material-ui/icons/ErrorOutlineSharp";
import ExpandMoreIcon from "@material-ui/icons/ExpandMore";
import LinkedInIcon from "@material-ui/icons/LinkedIn";
import GitHubIcon from "@material-ui/icons/GitHub";
import YouTubeIcon from "@material-ui/icons/YouTube";
import InstagramIcon from "@material-ui/icons/Instagram";
import TwitterIcon from "@material-ui/icons/Twitter";
import HeaderInfo from "../../components/util/HeadLine";
import { LinkedInLightBlue } from "../../assets/Colors";
import { LinkedInJobAdd } from "../../assets/images/images";
import Style from "./Style";

const Widgets = () => {
  const classes = Style();
  const [expand, setExpand] = useState(false);

  return (
    <div className={classes.widgets}>
      <Paper className={classes.widgets__top}>
        <div className={classes.heading}>
          <h4>LinkedIn News</h4>
          <ErrorOutlineSharpIcon />
        </div>
        {top_1.map((title, i) => (
          <HeaderInfo
            key={`widgets-top_1_${i}`}
            Icon={
              <FiberManualRecordIcon
                style={{
                  color: LinkedInLightBlue,
                  fontSize: 12,
                }}
              />
            }
            title={title}
            time={true}
            count={true}
          />
        ))}
        {expand &&
          top_2.map((title, i) => (
            <HeaderInfo
              key={`widgets-top_2_${i}`}
              Icon={<FiberManualRecordIcon style={{ color: LinkedInLightBlue, fontSize: 12 }} />}
              title={title}
              time={true}
              count={true}
            />
          ))}
        <div className={classes.expand} onClick={() => setExpand(!expand)}>
          <h4>{expand ? "Show less" : "Show more"}</h4>
          <ExpandMoreIcon style={{ transform: expand ? "rotate(180deg)" : "" }} />
        </div>
      </Paper>
      <div className={classes.widgets__bottom}>
        <Paper className={classes.addBanner}>
          <img src={LinkedInJobAdd} alt="linked-in-jub-add" />
        </Paper>
        {/* About Author */}
        <div className={classes.about}>
          <h4>Author Info</h4>
          <div>
            {author.map(({ src, url }, i) => (
              <a href={`${url}`} key={`author-link-${i}`} rel="noreferrer nofollow" target="_blank">
                {src}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const top_1 = [
  "Google cracks down on loan apps",
  "Byju’s new acquisition",
  "Lost password? That'll be $220M",
  "Tesla gets an India address",
  "India Inc returns gingerly to office",
];

const top_2 = [
  "To Bitcoin or not to Bitcoin",
  "Infosys, Wipro post robust numbers",
  "Longer hours equal less productivity",
  "Fake commute has real benefits",
];

const author = [
  { src: <GitHubIcon />, url: "https://github.com/phanison898" },
  { src: <LinkedInIcon />, url: "https://www.linkedin.com/in/phanison225/" },
  { src: <YouTubeIcon />, url: "https://www.youtube.com/channel/UC4FAldAo2Ow_2F447yggcqA" },
  { src: <InstagramIcon />, url: "https://www.instagram.com/phanison225/" },
  { src: <TwitterIcon />, url: "https://twitter.com/phanison225" },
];

export default Widgets;

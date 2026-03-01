import React, { useState } from "react";
import { Paper, Divider } from "@material-ui/core";
import PeopleIcon from "@material-ui/icons/People";
import ExpandMoreIcon from "@material-ui/icons/ExpandMore";
import AddIcon from "@material-ui/icons/Add";
import HeadLine from "../../util/HeadLine";
import Style from "./Style";

const SidebarBottom = () => {
  const classes = Style();
  const [recent, setRecent] = useState(true);
  const [groups, setGroups] = useState(true);
  const [hashTags, setHashTags] = useState(false);

  return (
    <Paper className={classes.sidebarBottom}>
      <section>
        <div className={classes.heading}>
          <h4>Recent</h4>
          <ExpandMoreIcon
            style={{ transform: recent ? "rotate(180deg)" : "" }}
            onClick={() => setRecent(!recent)}
          />
        </div>
        {recent && (
          <>
            {sectionRecent.map((title, i) => (
              <HeadLine key={`recent-${i}`} Icon={<h3>#</h3>} title={title} />
            ))}
          </>
        )}
      </section>
      <section>
        <div className={classes.heading}>
          <h4>Groups</h4>
          <ExpandMoreIcon
            style={{ transform: groups ? "rotate(180deg)" : "" }}
            onClick={() => setGroups(!groups)}
          />
        </div>
        {groups && (
          <>
            {sectionGroups.map((title, i) => (
              <HeadLine key={`groups-${i}`} Icon={<PeopleIcon />} title={title} />
            ))}
          </>
        )}
      </section>
      <section>
        <div className={classes.heading}>
          <h4>Events</h4>
          <AddIcon />
        </div>
      </section>
      <section>
        <div className={classes.heading}>
          <h4>Followed Hashtags</h4>
          <ExpandMoreIcon
            style={{ transform: hashTags ? "rotate(180deg)" : "" }}
            onClick={() => setHashTags(!hashTags)}
          />
        </div>
        {hashTags && (
          <>
            {sectionHashTags.map((title, i) => (
              <HeadLine key={`hashtags-${i}`} Icon={<h3>#</h3>} title={title} />
            ))}
          </>
        )}
      </section>
      <Divider />
      <div className={classes.discover__more}>
        <h4>Discover more</h4>
      </div>
    </Paper>
  );
};

const sectionRecent = ["node", "react", "react-native", "redux", "firebase", "mern-stack"];
const sectionGroups = ["react-community", "2021 developers"];
const sectionHashTags = [
  "androidapps",
  "careers",
  "entrepreneurship",
  "jobinterviews",
  "indiastudents",
  "india",
];

export default SidebarBottom;

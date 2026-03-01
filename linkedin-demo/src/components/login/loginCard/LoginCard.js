import React from "react";
import StyledFirebaseAuth from "react-firebaseui/StyledFirebaseAuth";
import { Paper } from "@material-ui/core";
import firebase from "firebase";
import LinkedInIcon from "@material-ui/icons/LinkedIn";
import GitHubIcon from "@material-ui/icons/GitHub";
import YouTubeIcon from "@material-ui/icons/YouTube";
import InstagramIcon from "@material-ui/icons/Instagram";
import TwitterIcon from "@material-ui/icons/Twitter";
import Logo from "../../../assets/images/text_logo.png";
import Style from "./Style";

const LoginCard = () => {
  const classes = Style();

  const uiConfig = {
    signInFlow: "popup",
    signInOptions: [firebase.auth.GoogleAuthProvider.PROVIDER_ID],
  };

  return (
    <Paper elevation={3} className={classes.card}>
      <header className={classes.header}>
        <img src={Logo} alt="logo" />
      </header>

      <form className={classes.form} onSubmit={(e) => e.preventDefault()}>
        <input disabled type="email" value="" placeholder="email" />
        <input disabled type="password" value="" placeholder="password" />
        <button disabled>Log In</button>
      </form>

      <div className={classes.google}>
        <section>
          <div></div>
          <p>OR</p>
          <div></div>
        </section>
        <StyledFirebaseAuth uiConfig={uiConfig} firebaseAuth={firebase.auth()} />
      </div>

      <footer className={classes.about}>
        <section>
          <div></div>
          <p>contact author</p>
          <div></div>
        </section>

        <div className={classes.social__links}>
          {author.map(({ src, url, color }, i) => (
            <a
              href={`${url}`}
              key={`author-link-${i}`}
              rel="noreferrer nofollow"
              target="_blank"
              style={{ color: color }}
            >
              {src}
            </a>
          ))}
        </div>
      </footer>
    </Paper>
  );
};

const author = [
  { src: <GitHubIcon />, url: "https://github.com/phanison898", color: "black" },
  { src: <LinkedInIcon />, url: "https://www.linkedin.com/in/phanison225/", color: "#5d98d4" },
  {
    src: <YouTubeIcon />,
    url: "https://www.youtube.com/channel/UC4FAldAo2Ow_2F447yggcqA",
    color: "red",
  },
  { src: <InstagramIcon />, url: "https://www.instagram.com/phanison225/", color: "#b7066e" },
  { src: <TwitterIcon />, url: "https://twitter.com/phanison225", color: "rgb(29 161 242)" },
];

export default LoginCard;

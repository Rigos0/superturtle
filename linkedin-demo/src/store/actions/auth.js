export const LoginAction = (user) => async (dispatch) => {
  dispatch({
    type: "LOGIN",
    payload: user,
  });
};

export const LogoutAction = () => async (dispatch) => {
  dispatch({
    type: "LOGOUT",
    payload: {},
  });
};

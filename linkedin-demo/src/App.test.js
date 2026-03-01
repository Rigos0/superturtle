import { render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { applyMiddleware, createStore } from "redux";
import thunk from "redux-thunk";
import App from "./App";
import reducers from "./store/reducers";
import { mockUser } from "./mock/user";

jest.mock("lottie-web", () => ({
  loadAnimation: jest.fn(),
}));

const renderApp = () => {
  const store = createStore(reducers, applyMiddleware(thunk));

  render(
    <Provider store={store}>
      <App />
    </Provider>
  );

  return store;
};

test("renders the feed shell without login or Firebase auth UI", async () => {
  const store = renderApp();

  expect(screen.getByText("Bíbr In")).not.toBeNull();
  expect(screen.getByPlaceholderText("Start a post")).not.toBeNull();
  expect(screen.queryByText("Log In")).toBeNull();
  expect(screen.queryByText("contact author")).toBeNull();

  await waitFor(() => {
    expect(store.getState().user.displayName).toBe(mockUser.displayName);
  });
});

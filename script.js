const API_BASE_URL = "https://script.google.com/macros/s/AKfycbzm9qYUzXWfmMSm_9M3rqnJbUNvrFUkIyD-MqVt1p77cGgs2urrSWOnsaaq1JU7fNvhlg/exec";

const state = {
  username: "",
  questions: [],
  currentIndex: 0,
  responsesByQuestionId: {},
  pendingSaveController: null,
};

const loginSection = document.getElementById("loginSection");
const quizSection = document.getElementById("quizSection");
const doneSection = document.getElementById("doneSection");

const usernameInput = document.getElementById("usernameInput");
const loginMessage = document.getElementById("loginMessage");
const startBtn = document.getElementById("startBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");

const progressText = document.getElementById("progressText");
const questionText = document.getElementById("questionText");
const answersContainer = document.getElementById("answersContainer");
const statusMessage = document.getElementById("statusMessage");
const nextBtn = document.getElementById("nextBtn");

const restartBtn = document.getElementById("restartBtn");

startBtn.addEventListener("click", startQuiz);
clearCacheBtn.addEventListener("click", clearCache);

usernameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") startQuiz();
});

nextBtn.addEventListener("click", goToNextQuestion);
restartBtn.addEventListener("click", resetApp);

async function startQuiz() {
  const username = usernameInput.value.trim();
  loginMessage.textContent = "";

  if (!username) {
    loginMessage.textContent = "Please enter a username.";
    return;
  }

  setLoading(startBtn, true, "Checking...");

  try {
    const result = await apiPost({
      action: "init",
      username,
    });

    if (!result.ok) {
      loginMessage.textContent = result.message || "Invalid username.";
      return;
    }

    state.username = result.username;
    state.questions = Array.isArray(result.questions) ? result.questions : [];
    state.currentIndex = 0;
    state.responsesByQuestionId = {};

    if (!state.questions.length) {
      loginMessage.textContent = "No questions available.";
      return;
    }

    loginSection.classList.add("hidden");
    doneSection.classList.add("hidden");
    quizSection.classList.remove("hidden");
    renderQuestion();
  } catch (error) {
    console.error(error);
    loginMessage.textContent = "Unable to connect to the system. Please try again.";
  } finally {
    setLoading(startBtn, false, "Start");
  }
}

async function clearCache() {
  loginMessage.textContent = "";
  setLoading(clearCacheBtn, true, "Clearing...");

  try {
    const result = await apiPost({
      action: "clear_cache",
    });

    if (result.ok) {
      loginMessage.textContent = "Cache cleared successfully.";
    } else {
      loginMessage.textContent = result.message || "Failed to clear cache.";
    }
  } catch (error) {
    console.error(error);
    loginMessage.textContent = "Error clearing cache. Please try again.";
  } finally {
    setLoading(clearCacheBtn, false, "Clear cache");
  }
}

function renderQuestion() {
  const question = state.questions[state.currentIndex];
  if (!question) {
    showDoneScreen();
    return;
  }

  progressText.textContent = `Question ${state.currentIndex + 1} / ${state.questions.length}`;
  questionText.textContent = question.question;
  answersContainer.innerHTML = "";
  statusMessage.textContent = "";

  const currentResponse = state.responsesByQuestionId[question.id] || {
    finalAnswer: "",
    changeCount: 0,
    submitCount: 0,
    isSaving: false,
  };

  nextBtn.disabled = !currentResponse.finalAnswer || currentResponse.isSaving;

  (question.answers || []).forEach((answer) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-btn";
    button.textContent = answer;

    if (currentResponse.finalAnswer === answer) {
      button.classList.add("selected");
    }
    if (currentResponse.isSaving) {
      button.disabled = true;
      button.classList.add("saving");
    }

    button.addEventListener("click", () => chooseAnswer(answer));
    answersContainer.appendChild(button);
  });
}

async function chooseAnswer(answer) {
  const question = state.questions[state.currentIndex];
  if (!question) return;

  const currentResponse = state.responsesByQuestionId[question.id] || {
    finalAnswer: "",
    changeCount: 0,
    submitCount: 0,
    isSaving: false,
  };

  const nextChangeCount =
    currentResponse.finalAnswer && currentResponse.finalAnswer !== answer
      ? currentResponse.changeCount + 1
      : currentResponse.changeCount;

  if (
    currentResponse.finalAnswer &&
    currentResponse.finalAnswer !== answer &&
    currentResponse.changeCount >= 2
  ) {
    statusMessage.textContent = "You can only change your answer up to 2 times.";
    return;
  }

  state.responsesByQuestionId[question.id] = {
    ...currentResponse,
    finalAnswer: answer,
    changeCount: nextChangeCount,
    submitCount: (currentResponse.submitCount || 0) + 1,
    isSaving: true,
  };

  updateAnswerSelection(answer);
  setAnswerButtonsDisabled(true);
  nextBtn.disabled = true;
  statusMessage.textContent = "";

  if (state.pendingSaveController) {
    state.pendingSaveController.abort();
  }

  const controller = new AbortController();
  state.pendingSaveController = controller;

  try {
    const result = await apiPost(
      {
        action: "save_answer",
        username: state.username,
        question: question.question,
        answer,
        changeCount: nextChangeCount,
        submitCount: (currentResponse.submitCount || 0) + 1,
      },
      controller.signal
    );

    if (!result.ok) {
      throw new Error(result.message || "Failed to save answer.");
    }

    const savedState = state.responsesByQuestionId[question.id] || {};

    state.responsesByQuestionId[question.id] = {
      ...savedState,
      finalAnswer: answer,
      changeCount: nextChangeCount,
      submitCount: (currentResponse.submitCount || 0) + 1,
      latestSavedAt: result.savedAt || "",
      isSaving: false,
    };

    setAnswerButtonsDisabled(false);
    updateAnswerSelection(answer);
    nextBtn.disabled = false;
    statusMessage.textContent = "";
  } catch (error) {
    if (error.name === "AbortError") return;

    console.error(error);

    const rollback = state.responsesByQuestionId[question.id] || {};

    state.responsesByQuestionId[question.id] = {
      ...rollback,
      isSaving: false,
    };

    setAnswerButtonsDisabled(false);
    nextBtn.disabled = false;
    statusMessage.textContent = "Failed to save answer. Please try again.";
  } finally {
    if (state.pendingSaveController === controller) {
      state.pendingSaveController = null;
    }
  }
}

function updateAnswerSelection(selectedAnswer) {
  const buttons = answersContainer.querySelectorAll(".answer-btn");
  buttons.forEach((button) => {
    button.classList.toggle("selected", button.textContent === selectedAnswer);
  });
}

function setAnswerButtonsDisabled(isDisabled) {
  const buttons = answersContainer.querySelectorAll(".answer-btn");
  buttons.forEach((button) => {
    button.disabled = isDisabled;
    button.classList.toggle("saving", isDisabled);
  });
}

function goToNextQuestion() {
  const question = state.questions[state.currentIndex];
  if (!question) return;

  const currentResponse = state.responsesByQuestionId[question.id];

  if (!currentResponse || !currentResponse.finalAnswer) {
    statusMessage.textContent = "Please select an answer before continuing.";
    return;
  }

  if (currentResponse.isSaving) return;

  state.currentIndex += 1;

  if (state.currentIndex >= state.questions.length) {
    showDoneScreen();
    return;
  }

  renderQuestion();
}

function showDoneScreen() {
  quizSection.classList.add("hidden");
  loginSection.classList.add("hidden");
  doneSection.classList.remove("hidden");
}

function resetApp() {
  state.username = "";
  state.questions = [];
  state.currentIndex = 0;
  state.responsesByQuestionId = {};
  state.pendingSaveController = null;

  usernameInput.value = "";
  loginMessage.textContent = "";
  statusMessage.textContent = "";
  nextBtn.disabled = true;

  doneSection.classList.add("hidden");
  quizSection.classList.add("hidden");
  loginSection.classList.remove("hidden");
  usernameInput.focus();
}

async function apiPost(payload, signal) {
  const response = await fetch(API_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function setLoading(button, isLoading, label) {
  button.disabled = isLoading;
  button.textContent = label;
}

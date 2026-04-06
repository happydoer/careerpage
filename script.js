const API_BASE_URL = "https://script.google.com/macros/s/AKfycbzm9qYUzXWfmMSm_9M3rqnJbUNvrFUkIyD-MqVt1p77cGgs2urrSWOnsaaq1JU7fNvhlg/exec";
const SAVE_QUEUE_KEY = "pending_answer_queue_v5";
const INIT_CACHE_KEY = "init_cache_v2";
const INIT_CACHE_MAX_AGE_MS = 3600000; // 1 hour

const state = {
  username: "",
  questions: [],
  currentIndex: 0,
  responsesByQuestionId: {},
  isQueueProcessing: false,
  currentSavePromise: null,
  currentSaveMeta: null,
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
nextBtn.addEventListener("click", goToNextQuestion);
restartBtn.addEventListener("click", resetApp);

usernameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") startQuiz();
});

window.addEventListener("online", () => {
  processSaveQueue();
});

window.addEventListener("focus", () => {
  processSaveQueue();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    processSaveQueue();
  }
});

setupExitFlush();

async function startQuiz() {
  const username = usernameInput.value.trim();
  loginMessage.textContent = "";

  if (!username) {
    loginMessage.textContent = "Please enter a username.";
    return;
  }

  // --- Fast path: check localStorage for cached init response ---
  const cached = getInitCache(username);
  if (cached) {
    applyInitResult(cached);
    // Background refresh: update cache silently, don't block UI
    apiPost({ action: "init", username })
      .then((result) => {
        if (result.ok) {
          setInitCache(username, result);
        }
      })
      .catch(() => { /* silent */ });
    return;
  }

  // --- Slow path: first-ever login, must wait for API ---
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

    setInitCache(username, result);
    applyInitResult(result);
  } catch (error) {
    console.error("startQuiz error:", error);
    loginMessage.textContent =
      "Unable to connect to the system. Please try again.";
  } finally {
    setLoading(startBtn, false, "Start");
  }
}

/** Apply a successful init result to app state and show quiz */
function applyInitResult(result) {
  state.username = result.username;
  state.questions = Array.isArray(result.questions) ? result.questions : [];
  state.currentIndex = 0;
  state.responsesByQuestionId = {};
  state.currentSavePromise = null;
  state.currentSaveMeta = null;

  if (!state.questions.length) {
    loginMessage.textContent = "No questions available.";
    return;
  }

  hydrateResponsesFromQueue(result.username);

  loginSection.classList.add("hidden");
  doneSection.classList.add("hidden");
  quizSection.classList.remove("hidden");
  renderQuestion();

  processSaveQueue();
}

function getInitCache(username) {
  try {
    const raw = localStorage.getItem(INIT_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (
      entry &&
      entry.username &&
      entry.username.toLowerCase() === username.toLowerCase() &&
      entry.cachedAt &&
      Date.now() - entry.cachedAt < INIT_CACHE_MAX_AGE_MS
    ) {
      return entry.data;
    }
    return null;
  } catch {
    return null;
  }
}

function setInitCache(username, data) {
  try {
    localStorage.setItem(
      INIT_CACHE_KEY,
      JSON.stringify({ username, data, cachedAt: Date.now() })
    );
  } catch {
    /* quota exceeded – ignore */
  }
}

async function clearCache() {
  loginMessage.textContent = "";
  setLoading(clearCacheBtn, true, "Clearing...");

  try {
    clearQueueStorage();
    localStorage.removeItem(INIT_CACHE_KEY);

    const result = await apiPost({
      action: "clear_cache",
    });

    if (result.ok) {
      loginMessage.textContent = "Cache cleared successfully.";
    } else {
      loginMessage.textContent = result.message || "Failed to clear cache.";
    }
  } catch (error) {
    console.error("clearCache error:", error);
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
    isSaved: true,
    pendingQueueId: null,
  };

  nextBtn.disabled = !currentResponse.finalAnswer;

  (question.answers || []).forEach((answer) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-btn";
    button.textContent = answer;

    if (currentResponse.finalAnswer === answer) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => chooseAnswer(answer));
    answersContainer.appendChild(button);
  });
}

function chooseAnswer(answer) {
  const question = state.questions[state.currentIndex];
  if (!question) return;

  const currentResponse = state.responsesByQuestionId[question.id] || {
    finalAnswer: "",
    changeCount: 0,
    submitCount: 0,
    isSaved: true,
    pendingQueueId: null,
  };

  const isDifferentAnswer =
    currentResponse.finalAnswer &&
    currentResponse.finalAnswer !== answer;

  const nextChangeCount = isDifferentAnswer
    ? currentResponse.changeCount + 1
    : currentResponse.changeCount;

  if (isDifferentAnswer && currentResponse.changeCount >= 2) {
    statusMessage.textContent = "You can only change your answer up to 2 times.";
    return;
  }

  const nextSubmitCount = (currentResponse.submitCount || 0) + 1;
  const queueId = generateId();

  if (currentResponse.pendingQueueId) {
    removeQueueItem(currentResponse.pendingQueueId);
  }

  state.responsesByQuestionId[question.id] = {
    ...currentResponse,
    finalAnswer: answer,
    changeCount: nextChangeCount,
    submitCount: nextSubmitCount,
    queuedAt: new Date().toISOString(),
    isSaved: false,
    pendingQueueId: queueId,
  };

  updateAnswerSelection(answer);
  nextBtn.disabled = false;
  statusMessage.textContent = "";

  const payload = {
    action: "save_answer",
    username: state.username,
    question: question.question,
    answer,
    submitCount: nextSubmitCount,
    changeCount: nextChangeCount,
  };

  enqueueSave({
    queueId,
    username: state.username,
    questionId: question.id,
    question: question.question,
    answer,
    submitCount: nextSubmitCount,
    changeCount: nextChangeCount,
    createdAt: new Date().toISOString(),
  });

  state.currentSaveMeta = {
    questionId: question.id,
    answer,
    submitCount: nextSubmitCount,
    queueId,
  };

  state.currentSavePromise = apiPost(payload)
    .then((result) => {
      if (!result.ok) {
        throw new Error(result.message || "Failed to save answer.");
      }

      removeQueueItem(queueId);

      const latestState = state.responsesByQuestionId[question.id];
      if (
        latestState &&
        latestState.finalAnswer === answer &&
        latestState.submitCount === nextSubmitCount
      ) {
        state.responsesByQuestionId[question.id] = {
          ...latestState,
          isSaved: true,
          latestSavedAt: result.savedAt || "",
          pendingQueueId: null,
        };
      }

      return result;
    })
    .catch((error) => {
      console.error("Immediate save error:", error);
      return null;
    });

  processSaveQueue();
}

async function goToNextQuestion() {
  const question = state.questions[state.currentIndex];
  if (!question) return;

  const currentResponse = state.responsesByQuestionId[question.id];

  if (!currentResponse || !currentResponse.finalAnswer) {
    statusMessage.textContent = "Please select an answer before continuing.";
    return;
  }

  statusMessage.textContent = "";

  const isLastQuestion = state.currentIndex >= state.questions.length - 1;

  if (isLastQuestion) {
    nextBtn.disabled = true;
    nextBtn.textContent = "Saving...";

    try {
      if (!currentResponse.isSaved) {
        const hasMatchingInFlightSave =
          state.currentSavePromise &&
          state.currentSaveMeta &&
          state.currentSaveMeta.questionId === question.id &&
          state.currentSaveMeta.answer === currentResponse.finalAnswer &&
          state.currentSaveMeta.submitCount === currentResponse.submitCount;

        if (hasMatchingInFlightSave) {
          const result = await state.currentSavePromise;
          if (!result) {
            throw new Error("Failed to confirm final answer save.");
          }
        } else {
          const result = await apiPost({
            action: "save_answer",
            username: state.username,
            question: question.question,
            answer: currentResponse.finalAnswer,
            submitCount: currentResponse.submitCount,
            changeCount: currentResponse.changeCount,
          });

          if (!result.ok) {
            throw new Error(result.message || "Failed to save the final answer.");
          }

          if (currentResponse.pendingQueueId) {
            removeQueueItem(currentResponse.pendingQueueId);
          }

          state.responsesByQuestionId[question.id] = {
            ...currentResponse,
            isSaved: true,
            latestSavedAt: result.savedAt || "",
            pendingQueueId: null,
          };
        }
      }

      showDoneScreen();
    } catch (error) {
      console.error("Final answer save error:", error);
      statusMessage.textContent =
        "We could not confirm the last answer was saved. Please try again.";
    } finally {
      nextBtn.disabled = false;
      nextBtn.textContent = "Next question";
    }

    return;
  }

  state.currentIndex += 1;
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
  state.isQueueProcessing = false;
  state.currentSavePromise = null;
  state.currentSaveMeta = null;

  usernameInput.value = "";
  loginMessage.textContent = "";
  statusMessage.textContent = "";
  nextBtn.disabled = true;
  nextBtn.textContent = "Next question";

  doneSection.classList.add("hidden");
  quizSection.classList.add("hidden");
  loginSection.classList.remove("hidden");
  usernameInput.focus();
}

async function processSaveQueue() {
  if (state.isQueueProcessing) return;
  if (!navigator.onLine) return;

  const queue = getQueueFromStorage();
  if (!queue.length) return;

  state.isQueueProcessing = true;

  try {
    while (true) {
      const currentQueue = getQueueFromStorage();
      if (!currentQueue.length) break;

      const item = currentQueue[0];

      const isHandledByImmediateSave =
        state.currentSaveMeta &&
        state.currentSaveMeta.queueId === item.queueId;

      if (isHandledByImmediateSave) {
        break;
      }

      try {
        const result = await apiPost({
          action: "save_answer",
          username: item.username,
          question: item.question,
          answer: item.answer,
          submitCount: item.submitCount,
          changeCount: item.changeCount,
        });

        if (!result.ok) {
          throw new Error(result.message || "Failed to save answer.");
        }

        removeQueueItem(item.queueId);

        const responseState = state.responsesByQuestionId[item.questionId];
        if (
          responseState &&
          responseState.finalAnswer === item.answer &&
          responseState.submitCount === item.submitCount
        ) {
          state.responsesByQuestionId[item.questionId] = {
            ...responseState,
            isSaved: true,
            latestSavedAt: result.savedAt || "",
            pendingQueueId: null,
          };
        }
      } catch (error) {
        console.error("processSaveQueue item error:", error);
        break;
      }
    }
  } finally {
    state.isQueueProcessing = false;
  }
}

function setupExitFlush() {
  window.addEventListener("pagehide", flushQueueOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushQueueOnExit();
    }
  });
}

function flushQueueOnExit() {
  const queue = getQueueFromStorage();
  if (!queue.length) return;

  const pendingItems = queue.slice(0, 10);

  pendingItems.forEach((item) => {
    const payload = JSON.stringify({
      action: "save_answer",
      username: item.username,
      question: item.question,
      answer: item.answer,
      submitCount: item.submitCount,
      changeCount: item.changeCount,
    });

    const blob = new Blob([payload], {
      type: "text/plain;charset=utf-8",
    });

    navigator.sendBeacon(API_BASE_URL, blob);
  });
}

function hydrateResponsesFromQueue(username) {
  const queue = getQueueFromStorage().filter(
    (item) => item.username === username
  );

  const latestByQuestionId = {};

  queue.forEach((item) => {
    const existing = latestByQuestionId[item.questionId];
    if (!existing || existing.submitCount <= item.submitCount) {
      latestByQuestionId[item.questionId] = item;
    }
  });

  Object.keys(latestByQuestionId).forEach((questionId) => {
    const item = latestByQuestionId[questionId];
    state.responsesByQuestionId[questionId] = {
      finalAnswer: item.answer,
      changeCount: item.changeCount,
      submitCount: item.submitCount,
      isSaved: false,
      pendingQueueId: item.queueId || null,
    };
  });
}

function updateAnswerSelection(selectedAnswer) {
  const buttons = answersContainer.querySelectorAll(".answer-btn");
  buttons.forEach((button) => {
    button.classList.toggle("selected", button.textContent === selectedAnswer);
  });
}

function enqueueSave(payload) {
  const queue = getQueueFromStorage();
  queue.push(payload);
  setQueueToStorage(queue);
}

function removeQueueItem(queueId) {
  const queue = getQueueFromStorage().filter((item) => item.queueId !== queueId);
  setQueueToStorage(queue);
}

function getQueueFromStorage() {
  try {
    const raw = localStorage.getItem(SAVE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("getQueueFromStorage error:", error);
    return [];
  }
}

function setQueueToStorage(queue) {
  localStorage.setItem(SAVE_QUEUE_KEY, JSON.stringify(queue));
}

function clearQueueStorage() {
  localStorage.removeItem(SAVE_QUEUE_KEY);
}

async function apiPost(payload) {
  const response = await fetch(API_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify(payload),
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

function generateId() {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const buttons = [...document.querySelectorAll('[data-tab]')];
const pages = [...document.querySelectorAll('.page')];
const toast = document.querySelector('#toast');
let timer;

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove('show'), 2400);
}

buttons.forEach((button) => button.addEventListener('click', () => {
  buttons.forEach((item) => item.classList.toggle('active', item === button));
  pages.forEach((page) => {
    const active = page.id === button.dataset.tab;
    page.hidden = !active;
    page.classList.toggle('active', active);
  });
}));

document.querySelector('#filters').addEventListener('submit', (event) => {
  event.preventDefault();
  notify('현재 입력한 조회 조건을 적용했습니다.');
});

document.querySelector('#filters').addEventListener('reset', () => {
  setTimeout(() => notify('조회 조건을 초기화했습니다.'), 0);
});


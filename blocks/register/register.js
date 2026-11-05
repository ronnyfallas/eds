import { getMetadata } from '../../scripts/ak.js';

export default function init(el) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'register-button';
  button.textContent = 'Register';
  button.addEventListener('click', () => {
    // eslint-disable-next-line no-console
    console.log({
      eventId: getMetadata('event-id'),
      registrationMode: getMetadata('registration-mode'),
    });
  });
  el.replaceChildren(button);
}

(() => {
  const header = document.getElementById('siteHeader');
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('primaryNav');
  const yearEl = document.getElementById('year');

  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Sticky header shadow on scroll
  const onScroll = () => {
    if (window.scrollY > 8) header.classList.add('scrolled');
    else header.classList.remove('scrolled');
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Mobile menu
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target instanceof HTMLAnchorElement) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Reveal-on-scroll
  const revealEls = document.querySelectorAll(
    '.section-head, .issue-card, .story, .stat, .action-list li, .mission-copy, .mission-card, .join-copy, .join-form'
  );
  revealEls.forEach((el) => el.classList.add('reveal'));

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('visible'));
  }

  // Animated counters
  const counters = document.querySelectorAll('.stat-num');
  const animateCount = (el) => {
    const target = parseInt(el.dataset.count || '0', 10);
    const suffix = el.dataset.suffix || '';
    const duration = 1600;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const value = Math.floor(target * ease(t));
      el.textContent = value.toLocaleString() + suffix;
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = target.toLocaleString() + suffix;
    };
    requestAnimationFrame(step);
  };

  if ('IntersectionObserver' in window) {
    const cio = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animateCount(entry.target);
            cio.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 }
    );
    counters.forEach((c) => cio.observe(c));
  } else {
    counters.forEach(animateCount);
  }

  // Join form (no backend — just friendly client-side handling)
  const form = document.getElementById('joinForm');
  const note = document.getElementById('formNote');
  if (form && note) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      note.classList.remove('error');
      const data = new FormData(form);
      const email = (data.get('email') || '').toString().trim();
      const zip = (data.get('zip') || '').toString().trim();
      const name = (data.get('name') || '').toString().trim();
      const role = (data.get('role') || '').toString().trim();

      if (!name || !email || !zip || !role) {
        note.textContent = 'Please fill in every field so we can connect you.';
        note.classList.add('error');
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        note.textContent = 'That email looks off — mind double-checking it?';
        note.classList.add('error');
        return;
      }
      if (!/^\d{5}$/.test(zip)) {
        note.textContent = 'ZIP should be a 5-digit number.';
        note.classList.add('error');
        return;
      }
      note.textContent =
        "You're in. Welcome to Farmers Fightback — we'll be in touch within 48 hours.";
      form.reset();
    });
  }
})();

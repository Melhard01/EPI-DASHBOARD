import { describe, test, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer, Modal } from '../src/components/ui/Overlay.jsx';
import Pagination from '../src/components/ui/Pagination.jsx';
import { EmptyState, ErrorState, InlineError, Spinner } from '../src/components/ui/States.jsx';
import { StatusBadge } from '../src/components/ui/Badge.jsx';
import { ApiError } from '../src/api/client.js';

// A dialog whose parent re-renders on every keystroke and passes a NEW onClose each time,
// exactly like the real forms do.
function TypingDialog({ onClose }) {
  const [value, setValue] = useState('');
  return (
    <Modal open title="Type here" onClose={() => onClose()}>
      <label>
        Email
        <input value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
    </Modal>
  );
}

describe('Overlay (dialogs and drawers)', () => {
  test('REGRESSION: typing keeps focus in the field while the dialog re-renders', async () => {
    const user = userEvent.setup();
    render(<TypingDialog onClose={() => {}} />);
    const input = screen.getByLabelText('Email');
    await user.type(input, 'boss@example.com');
    expect(input).toHaveValue('boss@example.com');
    expect(input).toHaveFocus();
  });

  test('moves focus into the dialog on open and back to the opener on close', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal open={open} title="Hello" onClose={() => setOpen(false)}>content</Modal>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    expect(screen.getByRole('dialog', { name: 'Hello' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  test('is an accessible modal dialog: role, label, close button, Escape, backdrop click, scroll lock', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<Drawer open title="Details" onClose={onClose}>body</Drawer>);
    const dialog = screen.getByRole('dialog', { name: 'Details' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(dialog.parentElement);
    expect(onClose).toHaveBeenCalledTimes(3);
    await user.click(screen.getByText('body'));
    expect(onClose).toHaveBeenCalledTimes(3);
    rerender(<Drawer open={false} title="Details" onClose={onClose}>body</Drawer>);
    expect(document.body.style.overflow).toBe('');
  });

  test('Escape closes only the topmost of two stacked overlays', async () => {
    const user = userEvent.setup();
    const closeDrawer = vi.fn();
    const closeModal = vi.fn();
    render(
      <>
        <Drawer open title="Drawer" onClose={closeDrawer}>a</Drawer>
        <Modal open title="Confirm" onClose={closeModal}>b</Modal>
      </>,
    );
    await user.keyboard('{Escape}');
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});

describe('Pagination', () => {
  test('first/last page disable the right arrow and describe the range', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { rerender } = render(<Pagination page={1} pageSize={10} total={25} totalPages={3} onPageChange={onPageChange} />);
    expect(screen.getByText('1–10 of 25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    rerender(<Pagination page={3} pageSize={10} total={25} totalPages={3} onPageChange={onPageChange} />);
    expect(screen.getByText('21–25 of 25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    rerender(<Pagination page={1} pageSize={10} total={0} totalPages={1} onPageChange={onPageChange} />);
    expect(screen.getByText('No results')).toBeInTheDocument();
  });
});

describe('state components', () => {
  test('loading, empty and error states are announced to assistive technology', () => {
    render(
      <>
        <Spinner label="Loading things…" />
        <EmptyState title="Nothing here" description="Add something." />
        <ErrorState error={new ApiError({ status: 500, message: 'Internal Server Error' })} onRetry={() => {}} />
        <InlineError>Bad input</InlineError>
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading things…');
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('InlineError renders nothing without a message; ErrorState survives a missing error', () => {
    const { container } = render(<InlineError>{null}</InlineError>);
    expect(container).toBeEmptyDOMElement();
    render(<ErrorState />);
    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
  });

  test('status badges use friendly labels and survive unknown statuses', () => {
    render(<><StatusBadge status="in_progress" /><StatusBadge status="on_hold" /></>);
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('On Hold')).toBeInTheDocument();
  });
});

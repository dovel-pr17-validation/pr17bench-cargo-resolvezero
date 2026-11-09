import { useMutation } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'

import { setActiveProfileCookie } from '../../lib/profile-cookie'
import { deleteProfile } from '../../server/profiles'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'

export function DeleteProfileButton({
  profile,
  canDelete,
}: {
  profile: { id: string; name: string }
  canDelete: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
        disabled={!canDelete}
        className="border-[#e7b4ae] text-[var(--danger)] hover:bg-[var(--accent-soft)]"
      >
        Delete this profile
      </Button>
      {!canDelete ? (
        <p className="mt-2 text-[10px] text-[var(--muted)]">You need at least one profile; create another one first.</p>
      ) : null}
      {open ? <DeleteProfileDialog profile={profile} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function DeleteProfileDialog({ profile, onClose }: { profile: { id: string; name: string }; onClose: () => void }) {
  const [confirmation, setConfirmation] = useState('')
  const remove = useMutation({
    mutationFn: () => deleteProfile({ data: { id: profile.id } }),
    onSuccess: (result) => {
      if (result.nextProfileId) setActiveProfileCookie(result.nextProfileId)
      window.location.assign('/')
    },
  })

  const matches = confirmation.trim().toLowerCase() === profile.name.toLowerCase()

  return (
    <Modal
      title={`Delete “${profile.name}”?`}
      description="This removes its rules, blocklists, local records, devices and stats. Linked devices stop resolving immediately. This cannot be undone."
      onClose={onClose}
    >
      <div className="mt-4 flex items-start gap-2 border border-[#e7b4ae] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--danger)]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>Type the profile name to confirm.</span>
      </div>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!remove.isPending && matches) remove.mutate()
        }}
      >
        <input
          autoFocus
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={profile.name}
          aria-label="Type the profile name to confirm"
          className="rz-input w-full"
        />
        {remove.isError ? (
          <p role="alert" className="text-[11px] text-[var(--danger)]">
            {remove.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={remove.isPending || !matches}
            className="border-[var(--danger)] bg-[var(--danger)] hover:border-[#b42318] hover:bg-[#b42318]"
          >
            {remove.isPending ? 'Deleting…' : 'Delete profile'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

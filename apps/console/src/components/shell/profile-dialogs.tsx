import { useMutation } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'

import { setActiveProfileCookie } from '../../lib/profile-cookie'
import { createProfile } from '../../server/profiles'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'

export function CreateProfileDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => createProfile({ data: { name } }),
    onSuccess: (profile) => {
      setActiveProfileCookie(profile.id)
      window.location.assign('/')
    },
  })

  return (
    <Modal
      title="New profile"
      description="A profile has its own rules, blocklists, logs and DoH/DoT endpoints. You can switch between them from the header."
      onClose={onClose}
    >
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!create.isPending && name.trim()) create.mutate()
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor="new-profile-name" className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
            Profile name
          </label>
          <input
            id="new-profile-name"
            autoFocus
            required
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Home, Office, Kids…"
            autoComplete="off"
            className="rz-input w-full"
          />
        </div>
        {create.isError ? (
          <p role="alert" className="text-[11px] text-[var(--danger)]">
            {create.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? <LoaderCircle size={14} className="animate-spin" /> : null}
            {create.isPending ? 'Creating…' : 'Create profile'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

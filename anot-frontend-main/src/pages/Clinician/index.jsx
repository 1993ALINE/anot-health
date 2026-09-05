import React from 'react'
import { authAPI } from '../../services/api'
import { stopRecordingKeepAlive } from '../../utils/recordingKeepAlive'
import { getCurrentUser } from '../../utils/getCurrentUser'
import ClinicianPortal from './ClinicianPortal'

export default function Clinician() {
  const cu = getCurrentUser()

  return (
    <ClinicianPortal
      currentUser={cu}
      onLogout={() => {
        stopRecordingKeepAlive().catch(() => {})
        authAPI.logout({ reload: true }).catch(() => {
          globalThis.location.replace('/login')
        })
      }}
    />
  )
}

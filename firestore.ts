import './utils/env.ts'
import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'

// The direct Firestore client, initialising the Firebase app on first use. Every call is a billed read, so
// reads of whole collections go through utils/cachedFirestore.ts instead.
const firestore = (): Firestore => {
  if (!getApps().length) {
    console.log('Firebase init')
    initializeApp({
      credential: cert({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // The key sits in .env with literal \n escapes.
        privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      }),
    })
  }

  return getFirestore()
}

export default firestore
